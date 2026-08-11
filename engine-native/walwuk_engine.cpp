#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

#include <emscripten.h>

namespace walwuk {

constexpr int kBoardSize = 9;
constexpr int kSquareCount = 81;
constexpr int kInfinity = 1'000'000;
constexpr int kWin = 100'000;
constexpr uint16_t kNoMove = 0xffff;
constexpr uint16_t kWallMove = 0x8000;
constexpr uint16_t kVerticalWall = 0x4000;
constexpr int kMaximumPvLength = 24;
constexpr std::size_t kTranspositionClusterCount = 1U << 18;
constexpr int kTranspositionClusterSize = 4;
constexpr int kMaximumSearchPly = 64;
constexpr int kMoveHistorySize = 81 + 128;
constexpr int kMaximumRaceExtensions = 2;

// The first few remaining walls are much more valuable than the last few.
// This prevents a short horizon from treating a stockpile of ten walls as
// only marginally better than a nearly empty reserve.
constexpr std::array<int, 11> kWallReserveValue = {
    0, 45, 84, 120, 150, 175, 198, 218, 236, 252, 266,
};

constexpr std::array<int, 4> kRowDirections = {-1, 1, 0, 0};
constexpr std::array<int, 4> kColumnDirections = {0, 0, -1, 1};

struct Bits81 {
  uint64_t low = 0;
  uint32_t high = 0;

  bool Test(int index) const {
    return index < 64 ? ((low >> index) & 1U) != 0
                      : ((high >> (index - 64)) & 1U) != 0;
  }

  void Set(int index) {
    if (index < 64) {
      low |= uint64_t{1} << index;
    } else {
      high |= uint32_t{1} << (index - 64);
    }
  }

  void Clear(int index) {
    if (index < 64) {
      low &= ~(uint64_t{1} << index);
    } else {
      high &= ~(uint32_t{1} << (index - 64));
    }
  }
};

Bits81 operator|(Bits81 left, Bits81 right) {
  return {left.low | right.low, left.high | right.high};
}

Bits81 operator&(Bits81 left, Bits81 right) {
  return {left.low & right.low, left.high & right.high};
}

Bits81 Without(Bits81 value, Bits81 removed) {
  return {value.low & ~removed.low, value.high & ~removed.high};
}

bool Any(Bits81 value) { return value.low != 0 || value.high != 0; }

Bits81 SquareBit(int square) {
  Bits81 result;
  result.Set(square);
  return result;
}

Bits81 ShiftLeft(Bits81 value, int shift) {
  Bits81 result;
  if (shift == 0) return value;
  result.low = value.low << shift;
  result.high = static_cast<uint32_t>((value.high << shift) |
                                      (value.low >> (64 - shift)));
  result.high &= 0x1ffffU;
  return result;
}

Bits81 ShiftRight(Bits81 value, int shift) {
  Bits81 result;
  if (shift == 0) return value;
  result.low = (value.low >> shift) |
               (static_cast<uint64_t>(value.high) << (64 - shift));
  result.high = value.high >> shift;
  return result;
}

Bits81 MakeRowMask(int row) {
  Bits81 result;
  for (int column = 0; column < 9; ++column) result.Set(row * 9 + column);
  return result;
}

Bits81 MakeColumnMask(int column) {
  Bits81 result;
  for (int row = 0; row < 9; ++row) result.Set(row * 9 + column);
  return result;
}

const Bits81 kTopRow = MakeRowMask(0);
const Bits81 kBottomRow = MakeRowMask(8);
const Bits81 kLeftColumn = MakeColumnMask(0);
const Bits81 kRightColumn = MakeColumnMask(8);

struct Position {
  std::array<uint8_t, 2> pawns{};
  std::array<uint8_t, 2> walls_left{};
  uint8_t turn = 0;
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  Bits81 blocked_up;
  Bits81 blocked_down;
  Bits81 blocked_left;
  Bits81 blocked_right;
};

struct PathResult {
  int distance = 99;
  uint64_t blocking_horizontal = 0;
  uint64_t blocking_vertical = 0;
};

struct MoveList {
  int count = 0;
  std::array<uint16_t, 136> moves{};

  void Push(uint16_t move) { moves[count++] = move; }
};

struct SearchMove {
  uint16_t move = kNoMove;
  std::array<PathResult, 2> child_paths{};
};

struct SearchMoveList {
  int count = 0;
  std::array<SearchMove, 136> moves{};

  void Push(uint16_t move, const std::array<PathResult, 2>& child_paths) {
    moves[count++] = {move, child_paths};
  }
};

enum class Bound : uint8_t { kExact, kLower, kUpper };
enum class SearchMode : uint8_t { kExhaustive, kSelective };

struct TranspositionEntry {
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  uint32_t metadata = 0;
  int32_t score = 0;
  uint16_t best_move = kNoMove;
  uint8_t depth = 0;
  Bound bound = Bound::kExact;
  uint8_t generation = 0;
  uint8_t search_mode = 0;
};

static_assert(sizeof(TranspositionEntry) == 32);

struct TranspositionCluster {
  std::array<TranspositionEntry, kTranspositionClusterSize> entries{};
};

static_assert(sizeof(TranspositionCluster) == 128);

struct AnalysisResult {
  uint16_t best_move = kNoMove;
  int score = 0;
  int depth = 0;
  int pv_length = 0;
  std::array<uint16_t, kMaximumPvLength> pv{};
  uint64_t nodes = 0;
  uint64_t transposition_hits = 0;
  int nps = 0;
  int time_ms = 0;
  const char* stop_reason = "depth";
  const char* score_bound = "exact";
  bool selective = false;
};

std::vector<TranspositionCluster> transposition_table(
    kTranspositionClusterCount);
uint8_t transposition_generation = 0;
std::string exported_result;

EM_JS(void, EmitProgress, (const char* json), {
  const callback = globalThis.__walwukProgress;
  if (typeof callback === "function") callback(UTF8ToString(json));
});

bool Inside(int row, int column) {
  return row >= 0 && row < kBoardSize && column >= 0 &&
         column < kBoardSize;
}

uint16_t PackPawnMove(int square) {
  return static_cast<uint16_t>(square);
}

uint16_t PackWallMove(int row, int column, bool vertical) {
  return kWallMove | (vertical ? kVerticalWall : 0) |
         static_cast<uint16_t>(row * 8 + column);
}

bool IsWallMove(uint16_t move) { return (move & kWallMove) != 0; }

bool IsVerticalWall(uint16_t move) { return (move & kVerticalWall) != 0; }

int MoveSquare(uint16_t move) { return move & 0x7f; }

int WallId(uint16_t move) { return move & 0x3f; }

int MoveHistoryIndex(uint16_t move) {
  if (!IsWallMove(move)) return MoveSquare(move);
  return 81 + WallId(move) + (IsVerticalWall(move) ? 64 : 0);
}

int WallReserveValue(int walls) {
  return kWallReserveValue[std::clamp(walls, 0, 10)];
}

int WallReserveCost(int walls) {
  if (walls <= 0) return kInfinity;
  return WallReserveValue(walls) - WallReserveValue(walls - 1);
}

void BeginSearchGeneration() {
  if (++transposition_generation == 0) {
    for (TranspositionCluster& cluster : transposition_table) {
      for (TranspositionEntry& entry : cluster.entries) entry.generation = 0;
    }
    transposition_generation = 1;
  }
}

uint32_t PositionMetadata(const Position& position) {
  return static_cast<uint32_t>(position.turn) |
         (static_cast<uint32_t>(position.pawns[0]) << 1) |
         (static_cast<uint32_t>(position.pawns[1]) << 8) |
         (static_cast<uint32_t>(position.walls_left[0]) << 15) |
         (static_cast<uint32_t>(position.walls_left[1]) << 19);
}

uint64_t MixHash(uint64_t value) {
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31);
}

std::size_t PositionIndex(const Position& position) {
  uint64_t hash = MixHash(position.horizontal_walls);
  hash ^= MixHash(position.vertical_walls + 0x9e3779b97f4a7c15ULL);
  hash ^= MixHash(PositionMetadata(position) + 0x243f6a8885a308d3ULL);
  return static_cast<std::size_t>(hash) &
         (kTranspositionClusterCount - 1);
}

bool SamePosition(const TranspositionEntry& entry,
                  const Position& position, SearchMode mode) {
  return entry.generation != 0 &&
         entry.horizontal_walls == position.horizontal_walls &&
         entry.vertical_walls == position.vertical_walls &&
         entry.metadata == PositionMetadata(position) &&
         entry.search_mode == static_cast<uint8_t>(mode);
}

int ScoreToTable(int score, int ply) {
  if (score > kWin - 100) return score + ply;
  if (score < -kWin + 100) return score - ply;
  return score;
}

int ScoreFromTable(int score, int ply) {
  if (score > kWin - 100) return score - ply;
  if (score < -kWin + 100) return score + ply;
  return score;
}

void AddWallUnchecked(Position* position, int row, int column,
                      bool vertical) {
  const int wall_id = row * 8 + column;
  if (vertical) {
    position->vertical_walls |= uint64_t{1} << wall_id;
    for (int blocked_row = row; blocked_row <= row + 1; ++blocked_row) {
      const int left = blocked_row * 9 + column;
      position->blocked_right.Set(left);
      position->blocked_left.Set(left + 1);
    }
  } else {
    position->horizontal_walls |= uint64_t{1} << wall_id;
    for (int blocked_column = column; blocked_column <= column + 1;
         ++blocked_column) {
      const int upper = row * 9 + blocked_column;
      position->blocked_down.Set(upper);
      position->blocked_up.Set(upper + 9);
    }
  }
}

void RemoveWallUnchecked(Position* position, int row, int column,
                         bool vertical) {
  const int wall_id = row * 8 + column;
  if (vertical) {
    position->vertical_walls &= ~(uint64_t{1} << wall_id);
    for (int blocked_row = row; blocked_row <= row + 1; ++blocked_row) {
      const int left = blocked_row * 9 + column;
      position->blocked_right.Clear(left);
      position->blocked_left.Clear(left + 1);
    }
  } else {
    position->horizontal_walls &= ~(uint64_t{1} << wall_id);
    for (int blocked_column = column; blocked_column <= column + 1;
         ++blocked_column) {
      const int upper = row * 9 + blocked_column;
      position->blocked_down.Clear(upper);
      position->blocked_up.Clear(upper + 9);
    }
  }
}

Position BuildPosition(int pawn_zero, int pawn_one, int walls_zero,
                       int walls_one, int turn, uint32_t horizontal_low,
                       uint32_t horizontal_high, uint32_t vertical_low,
                       uint32_t vertical_high) {
  Position position;
  position.pawns = {static_cast<uint8_t>(pawn_zero),
                    static_cast<uint8_t>(pawn_one)};
  position.walls_left = {static_cast<uint8_t>(walls_zero),
                         static_cast<uint8_t>(walls_one)};
  position.turn = static_cast<uint8_t>(turn);
  const uint64_t horizontal = static_cast<uint64_t>(horizontal_low) |
                              (static_cast<uint64_t>(horizontal_high) << 32);
  const uint64_t vertical = static_cast<uint64_t>(vertical_low) |
                            (static_cast<uint64_t>(vertical_high) << 32);
  for (int id = 0; id < 64; ++id) {
    if (((horizontal >> id) & 1U) != 0) {
      AddWallUnchecked(&position, id / 8, id % 8, false);
    }
    if (((vertical >> id) & 1U) != 0) {
      AddWallUnchecked(&position, id / 8, id % 8, true);
    }
  }
  return position;
}

bool Blocked(const Position& position, int from, int to) {
  if (to == from - 9) return position.blocked_up.Test(from);
  if (to == from + 9) return position.blocked_down.Test(from);
  if (to == from - 1) return position.blocked_left.Test(from);
  return position.blocked_right.Test(from);
}

Bits81 Expand(const Position& position, Bits81 frontier) {
  const Bits81 up_sources = Without(Without(frontier, kTopRow), position.blocked_up);
  const Bits81 down_sources =
      Without(Without(frontier, kBottomRow), position.blocked_down);
  const Bits81 left_sources =
      Without(Without(frontier, kLeftColumn), position.blocked_left);
  const Bits81 right_sources =
      Without(Without(frontier, kRightColumn), position.blocked_right);
  return ShiftRight(up_sources, 9) | ShiftLeft(down_sources, 9) |
         ShiftRight(left_sources, 1) | ShiftLeft(right_sources, 1);
}

int FirstSquare(Bits81 bits) {
  if (bits.low != 0) return __builtin_ctzll(bits.low);
  return 64 + __builtin_ctz(bits.high);
}

void AddBlockingWallCandidates(int first, int second, PathResult* result) {
  const int first_row = first / 9;
  const int first_column = first % 9;
  const int second_row = second / 9;
  const int second_column = second % 9;
  if (first_row != second_row) {
    const int row = first_row < second_row ? first_row : second_row;
    for (const int column : {first_column - 1, first_column}) {
      if (column >= 0 && column < 8) {
        result->blocking_horizontal |= uint64_t{1} << (row * 8 + column);
      }
    }
  } else {
    const int column =
        first_column < second_column ? first_column : second_column;
    for (const int row : {first_row - 1, first_row}) {
      if (row >= 0 && row < 8) {
        result->blocking_vertical |= uint64_t{1} << (row * 8 + column);
      }
    }
  }
}

PathResult ShortestPath(const Position& position, int player) {
  const Bits81 target = player == 0 ? kTopRow : kBottomRow;
  std::array<Bits81, kSquareCount> layers{};
  Bits81 frontier = SquareBit(position.pawns[player]);
  Bits81 visited = frontier;
  for (int distance = 0; distance < kSquareCount; ++distance) {
    layers[distance] = frontier;
    const Bits81 reached = frontier & target;
    if (Any(reached)) {
      PathResult result;
      result.distance = distance;
      int current = FirstSquare(reached);
      for (int layer = distance; layer > 0; --layer) {
        const Bits81 predecessors = Expand(position, SquareBit(current)) &
                                    layers[layer - 1];
        const int predecessor = FirstSquare(predecessors);
        AddBlockingWallCandidates(predecessor, current, &result);
        current = predecessor;
      }
      return result;
    }
    frontier = Without(Expand(position, frontier), visited);
    if (!Any(frontier)) break;
    visited = visited | frontier;
  }
  return {};
}

MoveList LegalPawnMoves(const Position& position, int player) {
  MoveList result;
  const int own = position.pawns[player];
  const int other = position.pawns[1 - player];
  const int own_row = own / 9;
  const int own_column = own % 9;
  auto add_destination = [&](int row, int column) {
    result.Push(PackPawnMove(row * 9 + column));
  };

  for (int direction = 0; direction < 4; ++direction) {
    const int row = own_row + kRowDirections[direction];
    const int column = own_column + kColumnDirections[direction];
    if (!Inside(row, column)) continue;
    const int adjacent = row * 9 + column;
    if (Blocked(position, own, adjacent)) continue;
    if (adjacent != other) {
      add_destination(row, column);
      continue;
    }

    const int beyond_row = row + kRowDirections[direction];
    const int beyond_column = column + kColumnDirections[direction];
    if (Inside(beyond_row, beyond_column)) {
      const int beyond = beyond_row * 9 + beyond_column;
      if (!Blocked(position, other, beyond)) {
        add_destination(beyond_row, beyond_column);
        continue;
      }
    }

    if (kRowDirections[direction] == 0) {
      for (const int side_row : {-1, 1}) {
        const int diagonal_row = row + side_row;
        if (!Inside(diagonal_row, column)) continue;
        const int diagonal = diagonal_row * 9 + column;
        if (!Blocked(position, other, diagonal)) {
          add_destination(diagonal_row, column);
        }
      }
    } else {
      for (const int side_column : {-1, 1}) {
        const int diagonal_column = column + side_column;
        if (!Inside(row, diagonal_column)) continue;
        const int diagonal = row * 9 + diagonal_column;
        if (!Blocked(position, other, diagonal)) {
          add_destination(row, diagonal_column);
        }
      }
    }
  }
  return result;
}

bool IsStructurallyLegalWall(const Position& position, int row, int column,
                             bool vertical) {
  if (row < 0 || row > 7 || column < 0 || column > 7 ||
      position.walls_left[position.turn] == 0) {
    return false;
  }
  const int id = row * 8 + column;
  const uint64_t own_walls =
      vertical ? position.vertical_walls : position.horizontal_walls;
  const uint64_t crossing_walls =
      vertical ? position.horizontal_walls : position.vertical_walls;
  if (((own_walls >> id) & 1U) != 0 ||
      ((crossing_walls >> id) & 1U) != 0) {
    return false;
  }
  if (vertical) {
    return (row == 0 || ((own_walls >> (id - 8)) & 1U) == 0) &&
           (row == 7 || ((own_walls >> (id + 8)) & 1U) == 0);
  }
  return (column == 0 || ((own_walls >> (id - 1)) & 1U) == 0) &&
         (column == 7 || ((own_walls >> (id + 1)) & 1U) == 0);
}

bool IsLegalWall(const Position& position, int row, int column,
                 bool vertical) {
  if (!IsStructurallyLegalWall(position, row, column, vertical)) return false;
  Position trial = position;
  AddWallUnchecked(&trial, row, column, vertical);
  return ShortestPath(trial, 0).distance < 99 &&
         ShortestPath(trial, 1).distance < 99;
}

bool WallTouchesWitness(const PathResult& path, int id, bool vertical) {
  const uint64_t candidates =
      vertical ? path.blocking_vertical : path.blocking_horizontal;
  return ((candidates >> id) & 1U) != 0;
}

bool IsSelectiveWallCandidate(
    const Position& position, const std::array<PathResult, 2>& paths, int id,
    bool vertical) {
  if (WallTouchesWitness(paths[0], id, vertical) ||
      WallTouchesWitness(paths[1], id, vertical)) {
    return true;
  }
  const int wall_row = id / 8;
  const int wall_column = id % 8;
  for (const uint8_t pawn : position.pawns) {
    const int pawn_row = pawn / 9;
    const int pawn_column = pawn % 9;
    int row_distance = wall_row - pawn_row;
    int column_distance = wall_column - pawn_column;
    if (row_distance < 0) row_distance = -row_distance;
    if (column_distance < 0) column_distance = -column_distance;
    if (row_distance <= 1 && column_distance <= 1) return true;
  }
  return false;
}

SearchMoveList GenerateSearchMoves(
    Position* position, const std::array<PathResult, 2>& paths,
    SearchMode mode = SearchMode::kExhaustive) {
  SearchMoveList result;
  const int player = position->turn;
  const MoveList pawn_moves = LegalPawnMoves(*position, player);
  const uint8_t original_pawn = position->pawns[player];
  for (int index = 0; index < pawn_moves.count; ++index) {
    const uint16_t move = pawn_moves.moves[index];
    position->pawns[player] = static_cast<uint8_t>(MoveSquare(move));
    std::array<PathResult, 2> child_paths = paths;
    child_paths[player] = ShortestPath(*position, player);
    result.Push(move, child_paths);
  }
  position->pawns[player] = original_pawn;

  if (position->walls_left[player] == 0) return result;
  for (int orientation = 0; orientation < 2; ++orientation) {
    const bool vertical = orientation == 1;
    for (int row = 0; row < 8; ++row) {
      for (int column = 0; column < 8; ++column) {
        if (!IsStructurallyLegalWall(*position, row, column, vertical)) {
          continue;
        }
        const int id = row * 8 + column;
        if (mode == SearchMode::kSelective &&
            !IsSelectiveWallCandidate(*position, paths, id, vertical)) {
          continue;
        }
        AddWallUnchecked(position, row, column, vertical);
        std::array<PathResult, 2> child_paths = paths;
        bool legal = true;
        for (int path_player = 0; path_player < 2; ++path_player) {
          if (WallTouchesWitness(paths[path_player], id, vertical)) {
            child_paths[path_player] = ShortestPath(*position, path_player);
            if (child_paths[path_player].distance >= 99) {
              legal = false;
              break;
            }
          }
        }
        RemoveWallUnchecked(position, row, column, vertical);
        if (legal) {
          result.Push(PackWallMove(row, column, vertical), child_paths);
        }
      }
    }
  }
  return result;
}

MoveList CandidateWalls(const Position& position, const PathResult& current,
                        const PathResult& opposing) {
  static_cast<void>(current);
  static_cast<void>(opposing);
  MoveList result;
  if (position.walls_left[position.turn] == 0) return result;
  for (int orientation = 0; orientation < 2; ++orientation) {
    for (int row = 0; row < 8; ++row) {
      for (int column = 0; column < 8; ++column) {
        if (IsLegalWall(position, row, column, orientation == 1)) {
          result.Push(PackWallMove(row, column, orientation == 1));
        }
      }
    }
  }
  return result;
}

MoveList GenerateMoves(const Position& position, const PathResult& current,
                       const PathResult& opposing) {
  MoveList result = LegalPawnMoves(position, position.turn);
  const MoveList walls = CandidateWalls(position, current, opposing);
  for (int index = 0; index < walls.count; ++index) {
    result.Push(walls.moves[index]);
  }
  return result;
}

Position ApplyMove(const Position& position, uint16_t move) {
  Position next = position;
  if (IsWallMove(move)) {
    const int id = WallId(move);
    AddWallUnchecked(&next, id / 8, id % 8, IsVerticalWall(move));
    --next.walls_left[position.turn];
  } else {
    next.pawns[position.turn] = static_cast<uint8_t>(MoveSquare(move));
  }
  next.turn = 1 - position.turn;
  return next;
}

void MakeMove(Position* position, uint16_t move) {
  const int player = position->turn;
  if (IsWallMove(move)) {
    const int id = WallId(move);
    AddWallUnchecked(position, id / 8, id % 8, IsVerticalWall(move));
    --position->walls_left[player];
  } else {
    position->pawns[player] = static_cast<uint8_t>(MoveSquare(move));
  }
  position->turn = static_cast<uint8_t>(1 - player);
}

void UnmakeMove(Position* position, uint16_t move, uint8_t original_pawn) {
  position->turn = static_cast<uint8_t>(1 - position->turn);
  const int player = position->turn;
  if (IsWallMove(move)) {
    const int id = WallId(move);
    RemoveWallUnchecked(position, id / 8, id % 8, IsVerticalWall(move));
    ++position->walls_left[player];
  } else {
    position->pawns[player] = original_pawn;
  }
}

int Winner(const Position& position) {
  if (position.pawns[0] / 9 == 0) return 0;
  if (position.pawns[1] / 9 == 8) return 1;
  return -1;
}

int StaticEvaluation(const Position& position) {
  const int winner = Winner(position);
  if (winner != -1) return winner == position.turn ? kWin : -kWin;
  const int periwinkle = ShortestPath(position, 0).distance;
  const int blossom = ShortestPath(position, 1).distance;
  const int path_score = (blossom - periwinkle) * 100;
  const int wall_score = WallReserveValue(position.walls_left[0]) -
                         WallReserveValue(position.walls_left[1]);
  const int mobility =
      (LegalPawnMoves(position, 0).count -
       LegalPawnMoves(position, 1).count) *
      4;
  const int absolute = path_score + wall_score + mobility;
  return position.turn == 0 ? absolute : -absolute;
}

int StaticEvaluation(const Position& position,
                     const std::array<PathResult, 2>& paths) {
  const int winner = Winner(position);
  if (winner != -1) return winner == position.turn ? kWin : -kWin;
  const int path_score = (paths[1].distance - paths[0].distance) * 100;
  const int wall_score = WallReserveValue(position.walls_left[0]) -
                         WallReserveValue(position.walls_left[1]);
  const int mobility =
      (LegalPawnMoves(position, 0).count -
       LegalPawnMoves(position, 1).count) *
      4;
  const int absolute = path_score + wall_score + mobility;
  return position.turn == 0 ? absolute : -absolute;
}

std::string MoveJson(uint16_t move) {
  if (move == kNoMove) return "null";
  std::ostringstream output;
  if (IsWallMove(move)) {
    const int id = WallId(move);
    output << "{\"kind\":\"wall\",\"wall\":{\"r\":" << id / 8
           << ",\"c\":" << id % 8 << ",\"o\":\""
           << (IsVerticalWall(move) ? 'v' : 'h') << "\"}}";
  } else {
    const int square = MoveSquare(move);
    output << "{\"kind\":\"pawn\",\"to\":{\"r\":" << square / 9
           << ",\"c\":" << square % 9 << "}}";
  }
  return output.str();
}

std::string MoveKey(uint16_t move) {
  std::ostringstream output;
  if (IsWallMove(move)) {
    const int id = WallId(move);
    output << (IsVerticalWall(move) ? 'v' : 'h') << id / 8 << id % 8;
  } else {
    const int square = MoveSquare(move);
    output << 'p' << square / 9 << square % 9;
  }
  return output.str();
}

std::string ResultJson(const AnalysisResult& result) {
  std::ostringstream output;
  output << "{\"bestMove\":" << MoveJson(result.best_move)
         << ",\"score\":" << result.score << ",\"depth\":" << result.depth
         << ",\"pv\":[";
  for (int index = 0; index < result.pv_length; ++index) {
    if (index != 0) output << ',';
    output << MoveJson(result.pv[index]);
  }
  output << "],\"nodes\":" << result.nodes << ",\"nps\":" << result.nps
         << ",\"timeMs\":" << result.time_ms << ",\"ttHits\":"
         << result.transposition_hits
         << ",\"selective\":" << (result.selective ? "true" : "false")
         << ",\"stopReason\":\""
         << result.stop_reason << "\",\"bound\":\""
         << result.score_bound << "\",\"backend\":\"wasm\"}";
  return output.str();
}

class Search {
 public:
  Search(const Position& initial, int max_depth, double time_ms,
         int root_index = 0, int root_count = 1,
         bool start_new_generation = true,
         SearchMode mode = SearchMode::kExhaustive)
      : initial_(initial),
        max_depth_(max_depth),
        time_ms_(time_ms),
        root_index_(root_index),
        root_count_(root_count),
        mode_(mode) {
    started_ = Clock::now();
    last_report_ = started_;
    if (start_new_generation) BeginSearchGeneration();
    completed_.selective = mode_ == SearchMode::kSelective;
    for (auto& player_history : history_) player_history.fill(0);
    for (auto& ply_killers : killers_) ply_killers = {kNoMove, kNoMove};
  }

  AnalysisResult Run() {
    const std::array<PathResult, 2> root_paths = {
        ShortestPath(initial_, 0), ShortestPath(initial_, 1)};
    completed_.score = StaticEvaluation(initial_, root_paths);
    for (int depth = 1; depth <= max_depth_; ++depth) {
      if (DeadlineReached()) {
        timed_out_ = true;
        break;
      }
      int alpha = -kInfinity;
      int beta = kInfinity;
      if (depth > 2) {
        alpha = completed_.score - 175;
        beta = completed_.score + 175;
      }
      root_best_move_ = kNoMove;
      int score =
          Negamax(&initial_, root_paths, depth, alpha, beta, 0, 0);
      if (timed_out_) break;
      if (score <= alpha || score >= beta) {
        score = Negamax(&initial_, root_paths, depth, -kInfinity, kInfinity,
                        0, 0);
        if (timed_out_) break;
      }

      completed_.score = score;
      completed_.depth = depth;
      ExtractPrincipalVariation(depth);
      completed_.best_move =
          completed_.pv_length == 0 ? kNoMove : completed_.pv[0];
      RefreshStatistics(&completed_);
      EmitProgress(ResultJson(completed_).c_str());
    }
    RefreshStatistics(&completed_);
    completed_.stop_reason =
        completed_.depth >= max_depth_ ? "depth" : "time";
    return completed_;
  }

  AnalysisResult RunRootMove(uint16_t root_move, int depth, int alpha,
                             int beta) {
    const std::array<PathResult, 2> root_paths = {
        ShortestPath(initial_, 0), ShortestPath(initial_, 1)};
    completed_.best_move = root_move;
    completed_.depth = depth > 0 ? depth - 1 : 0;
    completed_.score = StaticEvaluation(initial_, root_paths);
    completed_.pv[0] = root_move;
    completed_.pv_length = 1;

    Position root = initial_;
    SearchMoveList moves = GenerateSearchMoves(&root, root_paths, mode_);
    const SearchMove* selected = nullptr;
    for (int index = 0; index < moves.count; ++index) {
      if (moves.moves[index].move == root_move) {
        selected = &moves.moves[index];
        break;
      }
    }
    if (selected == nullptr || Winner(initial_) != -1) {
      completed_.best_move = kNoMove;
      completed_.pv_length = 0;
      RefreshStatistics(&completed_);
      return completed_;
    }

    return RunPreparedRootMove(root_move, selected->child_paths, root_paths,
                               depth, alpha, beta);
  }

  AnalysisResult RunPreparedRootMove(
      uint16_t root_move, const std::array<PathResult, 2>& child_paths,
      const std::array<PathResult, 2>& root_paths, int depth, int alpha,
      int beta) {
    completed_.best_move = root_move;
    completed_.depth = depth > 0 ? depth - 1 : 0;
    completed_.score = StaticEvaluation(initial_, root_paths);
    completed_.pv[0] = root_move;
    completed_.pv_length = 1;
    if (Winner(initial_) != -1) {
      completed_.best_move = kNoMove;
      completed_.pv_length = 0;
      RefreshStatistics(&completed_);
      return completed_;
    }

    Position root = initial_;
    const uint8_t original_pawn = root.pawns[root.turn];
    MakeMove(&root, root_move);
    const int score =
        -Negamax(&root, child_paths, depth - 1, -beta, -alpha, 1, 0);
    UnmakeMove(&root, root_move, original_pawn);
    completed_.score = score;
    completed_.depth = depth;
    completed_.score_bound = score <= alpha ? "upper"
                             : score >= beta ? "lower"
                                             : "exact";

    Position pv_position = ApplyMove(initial_, root_move);
    for (int index = 1; index < depth && index < kMaximumPvLength; ++index) {
      const TranspositionEntry* entry = FindEntry(pv_position);
      if (entry == nullptr || entry->best_move == kNoMove) break;
      completed_.pv[completed_.pv_length++] = entry->best_move;
      pv_position = ApplyMove(pv_position, entry->best_move);
      if (Winner(pv_position) != -1) break;
    }
    RefreshStatistics(&completed_);
    return completed_;
  }

 private:
  using Clock = std::chrono::steady_clock;

  bool DeadlineReached() const {
    if (time_ms_ < 0) return false;
    return std::chrono::duration<double, std::milli>(Clock::now() - started_)
               .count() >= time_ms_;
  }

  void RefreshStatistics(AnalysisResult* result) const {
    const double elapsed =
        std::chrono::duration<double, std::milli>(Clock::now() - started_)
            .count();
    result->nodes = nodes_;
    result->transposition_hits = transposition_hits_;
    result->time_ms = static_cast<int>(elapsed + 0.5);
    result->nps = static_cast<int>(nodes_ * 1000.0 / (elapsed < 1 ? 1 : elapsed));
  }

  void CheckTime() {
    if ((nodes_ & 255U) != 0) return;
    const Clock::time_point now = Clock::now();
    if (std::chrono::duration<double, std::milli>(now - last_report_).count() >=
        1000.0) {
      last_report_ = now;
      AnalysisResult progress = completed_;
      RefreshStatistics(&progress);
      EmitProgress(ResultJson(progress).c_str());
    }
    if (time_ms_ >= 0 &&
        std::chrono::duration<double, std::milli>(now - started_).count() >=
            time_ms_) {
      timed_out_ = true;
    }
  }

  TranspositionEntry* FindEntry(const Position& position) {
    TranspositionCluster& cluster =
        transposition_table[PositionIndex(position)];
    TranspositionEntry* best = nullptr;
    for (TranspositionEntry& entry : cluster.entries) {
      if (SamePosition(entry, position, mode_) &&
          (best == nullptr || entry.depth > best->depth)) {
        best = &entry;
      }
    }
    return best;
  }

  void StoreEntry(const Position& position, int depth, int score, Bound bound,
                  uint16_t best_move, int ply) {
    TranspositionCluster& cluster =
        transposition_table[PositionIndex(position)];
    TranspositionEntry* replacement = &cluster.entries[0];
    for (TranspositionEntry& candidate : cluster.entries) {
      if (SamePosition(candidate, position, mode_)) {
        replacement = &candidate;
        break;
      }
      if (candidate.generation == 0) {
        replacement = &candidate;
        break;
      }
      const int candidate_value =
          candidate.depth -
          (candidate.generation == transposition_generation ? 0 : 16);
      const int replacement_value =
          replacement->depth -
          (replacement->generation == transposition_generation ? 0 : 16);
      if (candidate_value < replacement_value) replacement = &candidate;
    }
    TranspositionEntry& entry = *replacement;
    if (SamePosition(entry, position, mode_) && entry.depth > depth &&
        entry.bound == Bound::kExact) {
      return;
    }
    entry.horizontal_walls = position.horizontal_walls;
    entry.vertical_walls = position.vertical_walls;
    entry.metadata = PositionMetadata(position);
    entry.score = ScoreToTable(score, ply);
    entry.best_move = best_move;
    entry.depth = static_cast<uint8_t>(depth);
    entry.bound = bound;
    entry.generation = transposition_generation;
    entry.search_mode = static_cast<uint8_t>(mode_);
  }

  void OrderMoves(const Position& position, SearchMoveList* moves,
                  uint16_t transposition_move,
                  const std::array<PathResult, 2>& paths, int ply) {
    std::array<int, 136> priorities{};
    for (int index = 0; index < moves->count; ++index) {
      const uint16_t move = moves->moves[index].move;
      int priority = move == transposition_move ? 1'000'000 : 0;
      if (ply < kMaximumSearchPly) {
        if (move == killers_[ply][0]) priority += 150'000;
        if (move == killers_[ply][1]) priority += 100'000;
      }
      priority += history_[position.turn][MoveHistoryIndex(move)];
      if (!IsWallMove(move)) {
        const int destination = MoveSquare(move);
        const int destination_row = destination / 9;
        if ((position.turn == 0 && destination_row == 0) ||
            (position.turn == 1 && destination_row == 8)) {
          priority += 500'000;
        }
        const int goal = position.turn == 0 ? 0 : 8;
        const int before_row = position.pawns[position.turn] / 9;
        const int after_row = destination_row;
        const int before_distance = before_row > goal ? before_row - goal
                                                      : goal - before_row;
        const int after_distance = after_row > goal ? after_row - goal
                                                    : goal - after_row;
        priority += (before_distance - after_distance) * 90;
        priority +=
            (paths[position.turn].distance -
             moves->moves[index].child_paths[position.turn].distance) *
            160;
      } else {
        const int player = position.turn;
        const auto& child_paths = moves->moves[index].child_paths;
        priority +=
            (child_paths[1 - player].distance - paths[1 - player].distance) *
                120 -
            (child_paths[player].distance - paths[player].distance) * 90;
        priority -= WallReserveCost(position.walls_left[player]);
      }
      priorities[index] = priority;
    }

    for (int index = 1; index < moves->count; ++index) {
      const SearchMove move = moves->moves[index];
      const int priority = priorities[index];
      int cursor = index;
      while (cursor > 0 && priorities[cursor - 1] < priority) {
        moves->moves[cursor] = moves->moves[cursor - 1];
        priorities[cursor] = priorities[cursor - 1];
        --cursor;
      }
      moves->moves[cursor] = move;
      priorities[cursor] = priority;
    }
  }

  bool IsRaceCritical(const std::array<PathResult, 2>& paths) const {
    const int shortest = std::min(paths[0].distance, paths[1].distance);
    const int longest = std::max(paths[0].distance, paths[1].distance);
    return shortest <= 2 || (shortest <= 3 && longest <= 4);
  }

  void RecordCutoff(int player, uint16_t move, int depth, int ply) {
    const int bonus = depth * depth;
    int& history = history_[player][MoveHistoryIndex(move)];
    history = std::min(32'000, history + bonus);
    if (ply >= kMaximumSearchPly || killers_[ply][0] == move) return;
    killers_[ply][1] = killers_[ply][0];
    killers_[ply][0] = move;
  }

  int Negamax(Position* position, const std::array<PathResult, 2>& paths,
              int depth, int alpha, int beta, int ply, int extensions) {
    ++nodes_;
    CheckTime();
    if (timed_out_) return 0;
    const int winner = Winner(*position);
    if (winner != -1) {
      return winner == position->turn ? kWin - ply : -kWin + ply;
    }
    alpha = std::max(alpha, -kWin + ply);
    beta = std::min(beta, kWin - ply);
    if (alpha >= beta) return alpha;
    if (depth <= 0) return StaticEvaluation(*position, paths);

    // A race extension changes the remaining selective horizon. Keep those
    // nodes out of the regular TT so an entry searched with fewer extensions
    // can never stand in for a position that is entitled to more foresight.
    // A split root likewise sees only a subset of legal root moves, so its
    // score must never become a full-position cache entry.
    const bool can_use_transposition =
        extensions == 0 && !(ply == 0 && root_count_ > 1);
    TranspositionEntry* cached =
        can_use_transposition ? FindEntry(*position) : nullptr;
    const int original_alpha = alpha;
    // Reuse a score only when it was searched at the requested depth. A
    // deeper entry remains valuable for move ordering, but returning it here
    // would make a fixed-depth request report a score from another horizon.
    const bool has_exact_transposition =
        cached != nullptr && cached->depth == depth;
    if (has_exact_transposition) {
      ++transposition_hits_;
      const int cached_score = ScoreFromTable(cached->score, ply);
      if (cached->bound == Bound::kExact) return cached_score;
      if (cached->bound == Bound::kLower) {
        if (cached_score > alpha) alpha = cached_score;
      } else if (cached_score < beta) {
        beta = cached_score;
      }
      if (alpha >= beta) return cached_score;
    }

    SearchMoveList moves = GenerateSearchMoves(position, paths, mode_);
    OrderMoves(*position, &moves,
               has_exact_transposition ? cached->best_move : kNoMove,
               paths, ply);
    if (moves.count == 0) {
      if (ply == 0) root_best_move_ = kNoMove;
      return StaticEvaluation(*position, paths);
    }

    int best_score = -kInfinity;
    uint16_t best_move = kNoMove;
    bool searched_move = false;
    int searched_count = 0;
    const int static_evaluation = StaticEvaluation(*position, paths);
    for (int index = 0; index < moves.count; ++index) {
      const uint16_t move = moves.moves[index].move;
      if (ply == 0 && root_count_ > 1 &&
          static_cast<int>(move % root_count_) != root_index_) {
        continue;
      }
      const bool transposition_move =
          has_exact_transposition && move == cached->best_move;
      const bool immediate_win =
          !IsWallMove(move) &&
          ((position->turn == 0 && MoveSquare(move) / 9 == 0) ||
           (position->turn == 1 && MoveSquare(move) / 9 == 8));
      if (mode_ == SearchMode::kSelective && ply > 0 &&
          IsWallMove(move) && !transposition_move && !immediate_win) {
        const int plausible_move_limit = 8 + 4 * depth;
        if (depth <= 5 && searched_count >= plausible_move_limit) continue;
        if (depth <= 3 && searched_count >= 4 &&
            static_evaluation + 140 * depth <= alpha) {
          continue;
        }
      }
      searched_move = true;
      ++searched_count;
      const uint8_t original_pawn = position->pawns[position->turn];
      MakeMove(position, move);
      int next_depth = depth - 1;
      int next_extensions = extensions;
      if (mode_ == SearchMode::kSelective && extensions < kMaximumRaceExtensions &&
          IsRaceCritical(moves.moves[index].child_paths)) {
        ++next_depth;
        ++next_extensions;
      }
      int score;
      if (searched_count == 1) {
        score = -Negamax(position, moves.moves[index].child_paths, next_depth,
                         -beta, -alpha, ply + 1, next_extensions);
      } else {
        int search_depth = next_depth;
        const bool reduce =
            mode_ == SearchMode::kSelective && ply > 0 && depth >= 3 &&
            searched_count > 4 && !transposition_move && !immediate_win;
        if (reduce) {
          int reduction = 1;
          if (depth >= 6 && searched_count > 10) reduction = 2;
          const int reduced_depth =
              search_depth > reduction ? search_depth - reduction : 0;
          score = -Negamax(position, moves.moves[index].child_paths,
                           reduced_depth, -alpha - 1, -alpha, ply + 1,
                           next_extensions);
          if (!timed_out_ && score > alpha) {
            score = -Negamax(position, moves.moves[index].child_paths,
                             search_depth, -alpha - 1, -alpha, ply + 1,
                             next_extensions);
          }
        } else {
          score = -Negamax(position, moves.moves[index].child_paths,
                           search_depth, -alpha - 1, -alpha, ply + 1,
                           next_extensions);
        }
        if (!timed_out_ && score > alpha && score < beta) {
          score = -Negamax(position, moves.moves[index].child_paths,
                           next_depth, -beta, -alpha, ply + 1,
                           next_extensions);
        }
      }
      UnmakeMove(position, move, original_pawn);
      if (timed_out_) return 0;
      if (score > best_score) {
        best_score = score;
        best_move = move;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        RecordCutoff(position->turn, move, depth, ply);
        break;
      }
    }

    if (!searched_move) return StaticEvaluation(*position, paths);

    Bound bound = Bound::kExact;
    if (best_score <= original_alpha) {
      bound = Bound::kUpper;
    } else if (best_score >= beta) {
      bound = Bound::kLower;
    }
    if (can_use_transposition) {
      StoreEntry(*position, depth, best_score, bound, best_move, ply);
    }
    if (ply == 0) root_best_move_ = best_move;
    return best_score;
  }

  void ExtractPrincipalVariation(int depth) {
    completed_.pv_length = 0;
    if (root_count_ > 1) {
      if (root_best_move_ == kNoMove) return;
      completed_.pv[completed_.pv_length++] = root_best_move_;
      Position position = ApplyMove(initial_, root_best_move_);
      for (int index = 1; index < depth && index < kMaximumPvLength; ++index) {
        const TranspositionEntry* entry = FindEntry(position);
        if (entry == nullptr || entry->best_move == kNoMove) break;
        completed_.pv[completed_.pv_length++] = entry->best_move;
        position = ApplyMove(position, entry->best_move);
        if (Winner(position) != -1) break;
      }
      return;
    }
    Position position = initial_;
    for (int index = 0; index < depth && index < kMaximumPvLength; ++index) {
      const TranspositionEntry* entry = FindEntry(position);
      if (entry == nullptr || entry->best_move == kNoMove) break;
      const uint16_t move = entry->best_move;
      completed_.pv[completed_.pv_length++] = move;
      position = ApplyMove(position, move);
      if (Winner(position) != -1) break;
    }
  }

  Position initial_;
  int max_depth_;
  double time_ms_;
  int root_index_;
  int root_count_;
  SearchMode mode_;
  Clock::time_point started_;
  Clock::time_point last_report_;
  uint64_t nodes_ = 0;
  uint64_t transposition_hits_ = 0;
  uint16_t root_best_move_ = kNoMove;
  std::array<std::array<int, kMoveHistorySize>, 2> history_{};
  std::array<std::array<uint16_t, 2>, kMaximumSearchPly> killers_{};
  bool timed_out_ = false;
  AnalysisResult completed_;
};

std::string SnapshotJson(const Position& position) {
  const PathResult current = ShortestPath(position, position.turn);
  const PathResult opposing = ShortestPath(position, 1 - position.turn);
  const MoveList pawn_moves = LegalPawnMoves(position, position.turn);
  const MoveList moves = GenerateMoves(position, current, opposing);
  std::ostringstream output;
  output << "{\"distances\":[" << ShortestPath(position, 0).distance << ','
         << ShortestPath(position, 1).distance << "],\"evaluation\":"
         << StaticEvaluation(position) << ",\"pawnMoves\":[";
  for (int index = 0; index < pawn_moves.count; ++index) {
    if (index != 0) output << ',';
    output << '\"' << MoveKey(pawn_moves.moves[index]) << '\"';
  }
  output << "],\"moves\":[";
  for (int index = 0; index < moves.count; ++index) {
    if (index != 0) output << ',';
    output << '\"' << MoveKey(moves.moves[index]) << '\"';
  }
  output << "],\"legalWalls\":[";
  bool first = true;
  for (int orientation = 0; orientation < 2; ++orientation) {
    for (int row = 0; row < 8; ++row) {
      for (int column = 0; column < 8; ++column) {
        if (!IsLegalWall(position, row, column, orientation == 1)) continue;
        if (!first) output << ',';
        first = false;
        output << '\"' << (orientation == 0 ? 'h' : 'v') << row << column
               << '\"';
      }
    }
  }
  output << "]}";
  return output.str();
}

std::string RootMovesJson(Position position) {
  const std::array<PathResult, 2> paths = {ShortestPath(position, 0),
                                           ShortestPath(position, 1)};
  const SearchMoveList moves = GenerateSearchMoves(&position, paths);
  std::ostringstream output;
  output << "{\"moves\":[";
  for (int index = 0; index < moves.count; ++index) {
    if (index != 0) output << ',';
    output << moves.moves[index].move;
  }
  output << "]}";
  return output.str();
}

}  // namespace walwuk

extern "C" {

EMSCRIPTEN_KEEPALIVE void walwuk_begin_search() {
  walwuk::BeginSearchGeneration();
}

EMSCRIPTEN_KEEPALIVE void walwuk_analyze(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high, int max_depth, double time_ms) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  walwuk::Search search(position, max_depth, time_ms);
  walwuk::exported_result = walwuk::ResultJson(search.Run());
}

EMSCRIPTEN_KEEPALIVE void walwuk_analyze_split(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high, int max_depth, double time_ms, int root_index,
    int root_count) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  const int safe_root_count = root_count > 0 ? root_count : 1;
  const int safe_root_index =
      root_index >= 0 && root_index < safe_root_count ? root_index : 0;
  walwuk::Search search(position, max_depth, time_ms, safe_root_index,
                        safe_root_count);
  walwuk::exported_result = walwuk::ResultJson(search.Run());
}

EMSCRIPTEN_KEEPALIVE void walwuk_analyze_selective(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high, int max_depth, double time_ms) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  walwuk::Search search(position, max_depth, time_ms, 0, 1, true,
                        walwuk::SearchMode::kSelective);
  walwuk::exported_result = walwuk::ResultJson(search.Run());
}

EMSCRIPTEN_KEEPALIVE void walwuk_analyze_selective_split(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high, int max_depth, double time_ms, int root_index,
    int root_count) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  const int safe_root_count = root_count > 0 ? root_count : 1;
  const int safe_root_index =
      root_index >= 0 && root_index < safe_root_count ? root_index : 0;
  walwuk::Search search(position, max_depth, time_ms, safe_root_index,
                        safe_root_count, true,
                        walwuk::SearchMode::kSelective);
  walwuk::exported_result = walwuk::ResultJson(search.Run());
}

EMSCRIPTEN_KEEPALIVE void walwuk_root_moves(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high) {
  walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  walwuk::exported_result = walwuk::RootMovesJson(position);
}

EMSCRIPTEN_KEEPALIVE void walwuk_search_root_move(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high, uint32_t root_move, int depth, int alpha,
    int beta) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  walwuk::Search search(position, depth, -1, 0, 1, false);
  walwuk::exported_result = walwuk::ResultJson(search.RunRootMove(
      static_cast<uint16_t>(root_move), depth, alpha, beta));
}

EMSCRIPTEN_KEEPALIVE void walwuk_snapshot(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  walwuk::exported_result = walwuk::SnapshotJson(position);
}

EMSCRIPTEN_KEEPALIVE const char* walwuk_result() {
  return walwuk::exported_result.c_str();
}

}  // extern "C"
