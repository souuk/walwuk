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
constexpr std::size_t kTranspositionSize = 1U << 20;

constexpr std::array<int, 4> kRowDirections = {-1, 1, 0, 0};
constexpr std::array<int, 4> kColumnDirections = {0, 0, -1, 1};

struct Bits72 {
  uint64_t low = 0;
  uint16_t high = 0;

  bool Test(int index) const {
    return index < 64 ? ((low >> index) & 1U) != 0
                      : ((high >> (index - 64)) & 1U) != 0;
  }

  void Set(int index) {
    if (index < 64) {
      low |= uint64_t{1} << index;
    } else {
      high |= uint16_t{1} << (index - 64);
    }
  }
};

struct Position {
  std::array<uint8_t, 2> pawns{};
  std::array<uint8_t, 2> walls_left{};
  uint8_t turn = 0;
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  Bits72 blocked_horizontal;
  Bits72 blocked_vertical;
};

struct PathResult {
  int distance = 99;
  int length = 0;
  std::array<uint8_t, kSquareCount> squares{};
};

struct MoveList {
  int count = 0;
  std::array<uint16_t, 136> moves{};

  void Push(uint16_t move) { moves[count++] = move; }
};

enum class Bound : uint8_t { kExact, kLower, kUpper };

struct TranspositionEntry {
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  uint32_t metadata = 0;
  int32_t score = 0;
  uint16_t best_move = kNoMove;
  uint8_t depth = 0;
  Bound bound = Bound::kExact;
  uint8_t generation = 0;
};

static_assert(sizeof(TranspositionEntry) == 32);

struct AnalysisResult {
  uint16_t best_move = kNoMove;
  int score = 0;
  int depth = 0;
  int pv_length = 0;
  std::array<uint16_t, 15> pv{};
  uint64_t nodes = 0;
  uint64_t transposition_hits = 0;
  int nps = 0;
  int time_ms = 0;
  const char* stop_reason = "depth";
};

std::vector<TranspositionEntry> transposition_table(kTranspositionSize);
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
  return static_cast<std::size_t>(hash) & (kTranspositionSize - 1);
}

bool SamePosition(const TranspositionEntry& entry,
                  const Position& position) {
  return entry.generation == transposition_generation &&
         entry.horizontal_walls == position.horizontal_walls &&
         entry.vertical_walls == position.vertical_walls &&
         entry.metadata == PositionMetadata(position);
}

void AddWallUnchecked(Position* position, int row, int column,
                      bool vertical) {
  const int wall_id = row * 8 + column;
  if (vertical) {
    position->vertical_walls |= uint64_t{1} << wall_id;
    position->blocked_vertical.Set(row * 8 + column);
    position->blocked_vertical.Set((row + 1) * 8 + column);
  } else {
    position->horizontal_walls |= uint64_t{1} << wall_id;
    position->blocked_horizontal.Set(row * 9 + column);
    position->blocked_horizontal.Set(row * 9 + column + 1);
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
  const int from_row = from / 9;
  const int from_column = from % 9;
  const int to_row = to / 9;
  const int to_column = to % 9;
  if (from_row != to_row) {
    const int row = from_row < to_row ? from_row : to_row;
    return position.blocked_horizontal.Test(row * 9 + from_column);
  }
  const int column = from_column < to_column ? from_column : to_column;
  return position.blocked_vertical.Test(from_row * 8 + column);
}

PathResult ShortestPath(const Position& position, int player) {
  const int start = position.pawns[player];
  const int target_row = player == 0 ? 0 : 8;
  std::array<uint8_t, kSquareCount> queue{};
  std::array<uint8_t, kSquareCount> seen{};
  std::array<int8_t, kSquareCount> parent{};
  parent.fill(-1);
  queue[0] = static_cast<uint8_t>(start);
  seen[start] = 1;
  int head = 0;
  int tail = 1;
  while (head < tail) {
    const int current = queue[head++];
    const int row = current / 9;
    const int column = current % 9;
    if (row == target_row) {
      PathResult result;
      std::array<uint8_t, kSquareCount> reverse_path{};
      int cursor = current;
      while (cursor != -1) {
        reverse_path[result.length++] = static_cast<uint8_t>(cursor);
        if (cursor == start) break;
        cursor = parent[cursor];
      }
      result.distance = result.length - 1;
      for (int i = 0; i < result.length; ++i) {
        result.squares[i] = reverse_path[result.length - i - 1];
      }
      return result;
    }
    for (int direction = 0; direction < 4; ++direction) {
      const int next_row = row + kRowDirections[direction];
      const int next_column = column + kColumnDirections[direction];
      if (!Inside(next_row, next_column)) continue;
      const int next = next_row * 9 + next_column;
      if (seen[next] || Blocked(position, current, next)) continue;
      seen[next] = 1;
      parent[next] = static_cast<int8_t>(current);
      queue[tail++] = static_cast<uint8_t>(next);
    }
  }
  return {};
}

MoveList LegalPawnMoves(const Position& position, int player) {
  MoveList result;
  std::array<uint8_t, kSquareCount> seen{};
  const int own = position.pawns[player];
  const int other = position.pawns[1 - player];
  const int own_row = own / 9;
  const int own_column = own % 9;
  auto add_destination = [&](int row, int column) {
    const int square = row * 9 + column;
    if (seen[square]) return;
    seen[square] = 1;
    result.Push(PackPawnMove(square));
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

bool IsLegalWall(const Position& position, int row, int column,
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
    if (row > 0 && ((own_walls >> (id - 8)) & 1U) != 0) return false;
    if (row < 7 && ((own_walls >> (id + 8)) & 1U) != 0) return false;
  } else {
    if (column > 0 && ((own_walls >> (id - 1)) & 1U) != 0) return false;
    if (column < 7 && ((own_walls >> (id + 1)) & 1U) != 0) return false;
  }

  Position trial = position;
  AddWallUnchecked(&trial, row, column, vertical);
  return ShortestPath(trial, 0).distance < 99 &&
         ShortestPath(trial, 1).distance < 99;
}

void AddPathCandidates(const PathResult& path, int edge_limit,
                       std::array<uint8_t, 128>* seen, MoveList* candidates) {
  const int edges = path.length - 1 < edge_limit ? path.length - 1 : edge_limit;
  for (int index = 0; index < edges; ++index) {
    const int first = path.squares[index];
    const int second = path.squares[index + 1];
    const int first_row = first / 9;
    const int first_column = first % 9;
    const int second_row = second / 9;
    const int second_column = second % 9;
    if (first_row != second_row) {
      const int row = first_row < second_row ? first_row : second_row;
      for (const int column : {first_column - 1, first_column}) {
        if (column < 0 || column > 7) continue;
        const int candidate = row * 8 + column;
        if ((*seen)[candidate]) continue;
        (*seen)[candidate] = 1;
        candidates->Push(PackWallMove(row, column, false));
      }
    } else {
      const int column =
          first_column < second_column ? first_column : second_column;
      for (const int row : {first_row - 1, first_row}) {
        if (row < 0 || row > 7) continue;
        const int candidate = 64 + row * 8 + column;
        if ((*seen)[candidate]) continue;
        (*seen)[candidate] = 1;
        candidates->Push(PackWallMove(row, column, true));
      }
    }
  }
}

MoveList CandidateWalls(const Position& position, const PathResult& current,
                        const PathResult& opposing) {
  MoveList candidates;
  MoveList result;
  if (position.walls_left[position.turn] == 0) return result;
  std::array<uint8_t, 128> seen{};
  AddPathCandidates(opposing, kSquareCount, &seen, &candidates);
  AddPathCandidates(current, 4, &seen, &candidates);

  for (const int pawn : position.pawns) {
    const int pawn_row = pawn / 9;
    const int pawn_column = pawn % 9;
    for (int row_offset = -1; row_offset <= 0; ++row_offset) {
      for (int column_offset = -1; column_offset <= 0; ++column_offset) {
        const int row = pawn_row + row_offset;
        const int column = pawn_column + column_offset;
        if (row < 0 || row > 7 || column < 0 || column > 7) continue;
        for (int orientation = 0; orientation < 2; ++orientation) {
          const int candidate = orientation * 64 + row * 8 + column;
          if (seen[candidate]) continue;
          seen[candidate] = 1;
          candidates.Push(PackWallMove(row, column, orientation == 1));
        }
      }
    }
  }

  for (int index = 0; index < candidates.count; ++index) {
    const uint16_t move = candidates.moves[index];
    const int wall_id = WallId(move);
    if (IsLegalWall(position, wall_id / 8, wall_id % 8,
                    IsVerticalWall(move))) {
      result.Push(move);
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
  const int wall_score =
      (position.walls_left[0] - position.walls_left[1]) * 13;
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
         << ",\"selective\":true,\"stopReason\":\""
         << result.stop_reason << "\",\"backend\":\"wasm\"}";
  return output.str();
}

class Search {
 public:
  Search(const Position& initial, int max_depth, double time_ms)
      : initial_(initial), max_depth_(max_depth), time_ms_(time_ms) {
    started_ = Clock::now();
    last_report_ = started_;
    if (++transposition_generation == 0) {
      for (TranspositionEntry& entry : transposition_table) {
        entry.generation = 0;
      }
      transposition_generation = 1;
    }
  }

  AnalysisResult Run() {
    completed_.score = StaticEvaluation(initial_);
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
      int score = Negamax(initial_, depth, alpha, beta, 0);
      if (timed_out_) break;
      if (score <= alpha || score >= beta) {
        score = Negamax(initial_, depth, -kInfinity, kInfinity, 0);
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
    TranspositionEntry& entry =
        transposition_table[PositionIndex(position)];
    return SamePosition(entry, position) ? &entry : nullptr;
  }

  void StoreEntry(const Position& position, int depth, int score, Bound bound,
                  uint16_t best_move) {
    TranspositionEntry& entry =
        transposition_table[PositionIndex(position)];
    if (entry.generation == transposition_generation &&
        !SamePosition(entry, position) && entry.depth > depth) {
      return;
    }
    entry.horizontal_walls = position.horizontal_walls;
    entry.vertical_walls = position.vertical_walls;
    entry.metadata = PositionMetadata(position);
    entry.score = score;
    entry.best_move = best_move;
    entry.depth = static_cast<uint8_t>(depth);
    entry.bound = bound;
    entry.generation = transposition_generation;
  }

  void OrderMoves(const Position& position, MoveList* moves,
                  uint16_t transposition_move, int before_current,
                  int before_opposing) {
    std::array<int, 136> priorities{};
    for (int index = 0; index < moves->count; ++index) {
      const uint16_t move = moves->moves[index];
      int priority = move == transposition_move ? 1'000'000 : 0;
      const Position next = ApplyMove(position, move);
      if (Winner(next) == position.turn) priority += 500'000;
      if (!IsWallMove(move)) {
        const int goal = position.turn == 0 ? 0 : 8;
        const int before_row = position.pawns[position.turn] / 9;
        const int after_row = MoveSquare(move) / 9;
        const int before_distance = before_row > goal ? before_row - goal
                                                      : goal - before_row;
        const int after_distance = after_row > goal ? after_row - goal
                                                    : goal - after_row;
        priority += (before_distance - after_distance) * 90;
      } else {
        const int after_current = ShortestPath(next, position.turn).distance;
        const int after_opposing =
            ShortestPath(next, 1 - position.turn).distance;
        priority += (after_opposing - before_opposing) * 120 -
                    (after_current - before_current) * 90;
      }
      priorities[index] = priority;
    }

    for (int index = 1; index < moves->count; ++index) {
      const uint16_t move = moves->moves[index];
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

  int Negamax(const Position& position, int depth, int alpha, int beta,
              int ply) {
    ++nodes_;
    CheckTime();
    if (timed_out_) return 0;
    const int winner = Winner(position);
    if (winner != -1) {
      return winner == position.turn ? kWin - ply : -kWin + ply;
    }
    if (depth <= 0) return StaticEvaluation(position);

    TranspositionEntry* cached = FindEntry(position);
    const int original_alpha = alpha;
    if (cached != nullptr && cached->depth >= depth) {
      ++transposition_hits_;
      if (cached->bound == Bound::kExact) return cached->score;
      if (cached->bound == Bound::kLower) {
        if (cached->score > alpha) alpha = cached->score;
      } else if (cached->score < beta) {
        beta = cached->score;
      }
      if (alpha >= beta) return cached->score;
    }

    const PathResult current = ShortestPath(position, position.turn);
    const PathResult opposing = ShortestPath(position, 1 - position.turn);
    MoveList moves = GenerateMoves(position, current, opposing);
    OrderMoves(position, &moves,
               cached == nullptr ? kNoMove : cached->best_move,
               current.distance, opposing.distance);
    if (moves.count == 0) return StaticEvaluation(position);

    int best_score = -kInfinity;
    uint16_t best_move = kNoMove;
    for (int index = 0; index < moves.count; ++index) {
      const int score = -Negamax(ApplyMove(position, moves.moves[index]),
                                 depth - 1, -beta, -alpha, ply + 1);
      if (timed_out_) return 0;
      if (score > best_score) {
        best_score = score;
        best_move = moves.moves[index];
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }

    Bound bound = Bound::kExact;
    if (best_score <= original_alpha) {
      bound = Bound::kUpper;
    } else if (best_score >= beta) {
      bound = Bound::kLower;
    }
    StoreEntry(position, depth, best_score, bound, best_move);
    return best_score;
  }

  void ExtractPrincipalVariation(int depth) {
    completed_.pv_length = 0;
    Position position = initial_;
    for (int index = 0; index < depth && index < 15; ++index) {
      const TranspositionEntry* entry = FindEntry(position);
      if (entry == nullptr || entry->best_move == kNoMove) break;
      completed_.pv[completed_.pv_length++] = entry->best_move;
      position = ApplyMove(position, entry->best_move);
      if (Winner(position) != -1) break;
    }
  }

  Position initial_;
  int max_depth_;
  double time_ms_;
  Clock::time_point started_;
  Clock::time_point last_report_;
  uint64_t nodes_ = 0;
  uint64_t transposition_hits_ = 0;
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

}  // namespace walwuk

extern "C" {

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
