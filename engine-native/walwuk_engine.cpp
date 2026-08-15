#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <sstream>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace walwuk {

#ifdef WALWUK_PROFILE
struct ProfilingCounters {
  uint64_t full_path_searches = 0;
  uint64_t path_cache_hits = 0;
  uint64_t wall_candidates = 0;
  uint64_t child_paths_prepared = 0;
  uint64_t illegal_walls = 0;
  uint64_t tt_probes = 0;
};

ProfilingCounters profiling;
#define WALWUK_PROFILE_INCREMENT(field) (++profiling.field)
#else
#define WALWUK_PROFILE_INCREMENT(field) ((void)0)
#endif

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
constexpr int kPawnStateCount = kSquareCount * kSquareCount * 2;
constexpr std::size_t kZeroWallCacheSize = 64;
constexpr uint64_t kHashSeed = 0x6a09e667f3bcc909ULL;
constexpr const char* kEngineVersion = "phase3.0-dev";
constexpr const char* kEvaluatorVersion = "handcrafted-v2";
constexpr const char* kPolicyVersion = "history-v1";
constexpr uint32_t kExperimentTopologyCache = 1U << 0;
constexpr uint32_t kExperimentAdvancedHistory = 1U << 1;
constexpr uint32_t kExperimentStrategicEvaluator = 1U << 2;
constexpr uint32_t kExperimentZeroWallAtFrontier = 1U << 3;
constexpr uint32_t kExperimentPartialMoveSelection = 1U << 4;
constexpr uint32_t kExperimentQuiescence = 1U << 5;
constexpr uint32_t kExperimentAdaptiveReductions = 1U << 6;
constexpr uint32_t kExperimentCorrectionHistory = 1U << 7;
constexpr uint32_t kExperimentLearnedValue = 1U << 8;
constexpr uint32_t kExperimentReverseFutility = 1U << 9;
constexpr uint32_t kExperimentRazoring = 1U << 10;
constexpr uint32_t kExperimentProbCut = 1U << 11;
constexpr uint32_t kExperimentHistoryPruning = 1U << 12;
constexpr uint32_t kExperimentMultiCut = 1U << 13;
constexpr uint32_t kExperimentSingularExtension = 1U << 14;
constexpr uint32_t kExperimentForcedDefenseExtension = 1U << 15;
constexpr uint32_t kExperimentCanonicalTranspositions = 1U << 16;
constexpr uint32_t kExperimentAllShortestRoutes = 1U << 17;
constexpr uint32_t kExperimentTopologyV3 = 1U << 18;
constexpr uint32_t kExperimentConservativeAdaptiveReductions = 1U << 19;
constexpr uint32_t kExperimentGuardedAdaptiveReductions = 1U << 20;
constexpr std::size_t kCorrectionHistorySize = 1U << 12;
constexpr std::size_t kTopologyCacheSize = 1U << 14;

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
  uint64_t key = 0;
  uint64_t mirror_key = 0;
};

uint64_t NextHashRandom(uint64_t* state) {
  *state += 0x9e3779b97f4a7c15ULL;
  uint64_t value = *state;
  value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
  value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
  return value ^ (value >> 31);
}

struct ZobristKeys {
  std::array<std::array<uint64_t, kSquareCount>, 2> pawns{};
  std::array<std::array<uint64_t, 64>, 2> walls{};
  std::array<std::array<uint64_t, 11>, 2> reserves{};
  uint64_t turn = 0;
};

ZobristKeys MakeZobristKeys() {
  ZobristKeys keys;
  uint64_t state = kHashSeed;
  for (auto& player : keys.pawns) {
    for (uint64_t& key : player) key = NextHashRandom(&state);
  }
  for (auto& orientation : keys.walls) {
    for (uint64_t& key : orientation) key = NextHashRandom(&state);
  }
  for (auto& player : keys.reserves) {
    for (uint64_t& key : player) key = NextHashRandom(&state);
  }
  keys.turn = NextHashRandom(&state);
  return keys;
}

const ZobristKeys kZobrist = MakeZobristKeys();

uint64_t ComputePositionKey(const Position& position) {
  uint64_t key = kZobrist.pawns[0][position.pawns[0]] ^
                 kZobrist.pawns[1][position.pawns[1]] ^
                 kZobrist.reserves[0][position.walls_left[0]] ^
                 kZobrist.reserves[1][position.walls_left[1]];
  if (position.turn != 0) key ^= kZobrist.turn;
  for (int id = 0; id < 64; ++id) {
    if (((position.horizontal_walls >> id) & 1U) != 0) {
      key ^= kZobrist.walls[0][id];
    }
    if (((position.vertical_walls >> id) & 1U) != 0) {
      key ^= kZobrist.walls[1][id];
    }
  }
  return key;
}

constexpr int MirrorSquareId(int square) {
  return (square / 9) * 9 + (8 - square % 9);
}

constexpr int MirrorWallId(int wall_id) {
  return (wall_id / 8) * 8 + (7 - wall_id % 8);
}

uint64_t ComputeMirrorPositionKey(const Position& position) {
  uint64_t key = kZobrist.pawns[0][MirrorSquareId(position.pawns[0])] ^
                 kZobrist.pawns[1][MirrorSquareId(position.pawns[1])] ^
                 kZobrist.reserves[0][position.walls_left[0]] ^
                 kZobrist.reserves[1][position.walls_left[1]];
  if (position.turn != 0) key ^= kZobrist.turn;
  for (int id = 0; id < 64; ++id) {
    const int mirrored = MirrorWallId(id);
    if (((position.horizontal_walls >> id) & 1U) != 0) {
      key ^= kZobrist.walls[0][mirrored];
    }
    if (((position.vertical_walls >> id) & 1U) != 0) {
      key ^= kZobrist.walls[1][mirrored];
    }
  }
  return key;
}

struct WallConflictMasks {
  std::array<std::array<uint64_t, 64>, 2> same_orientation{};
};

WallConflictMasks MakeWallConflictMasks() {
  WallConflictMasks masks;
  for (int orientation = 0; orientation < 2; ++orientation) {
    for (int row = 0; row < 8; ++row) {
      for (int column = 0; column < 8; ++column) {
        const int id = row * 8 + column;
        uint64_t conflicts = uint64_t{1} << id;
        if (orientation == 0) {
          if (column > 0) conflicts |= uint64_t{1} << (id - 1);
          if (column < 7) conflicts |= uint64_t{1} << (id + 1);
        } else {
          if (row > 0) conflicts |= uint64_t{1} << (id - 8);
          if (row < 7) conflicts |= uint64_t{1} << (id + 8);
        }
        masks.same_orientation[orientation][id] = conflicts;
      }
    }
  }
  return masks;
}

const WallConflictMasks kWallConflicts = MakeWallConflictMasks();

struct WallBlockedMasks {
  std::array<Bits81, 64> up{};
  std::array<Bits81, 64> down{};
  std::array<Bits81, 64> left{};
  std::array<Bits81, 64> right{};
};

WallBlockedMasks MakeWallBlockedMasks() {
  WallBlockedMasks masks;
  for (int row = 0; row < 8; ++row) {
    for (int column = 0; column < 8; ++column) {
      const int id = row * 8 + column;
      for (int offset = 0; offset < 2; ++offset) {
        const int upper = row * 9 + column + offset;
        masks.down[id].Set(upper);
        masks.up[id].Set(upper + 9);
        const int left = (row + offset) * 9 + column;
        masks.right[id].Set(left);
        masks.left[id].Set(left + 1);
      }
    }
  }
  return masks;
}

const WallBlockedMasks kWallBlocked = MakeWallBlockedMasks();

constexpr uint64_t MakeWallColumnMask(int column) {
  uint64_t mask = 0;
  for (int row = 0; row < 8; ++row) {
    mask |= uint64_t{1} << (row * 8 + column);
  }
  return mask;
}

constexpr uint64_t kWallColumnZero = MakeWallColumnMask(0);
constexpr uint64_t kWallColumnSeven = MakeWallColumnMask(7);

constexpr std::array<uint64_t, kSquareCount> MakeNearPawnWallMasks() {
  std::array<uint64_t, kSquareCount> masks{};
  for (int square = 0; square < kSquareCount; ++square) {
    const int pawn_row = square / 9;
    const int pawn_column = square % 9;
    for (int row = std::max(0, pawn_row - 1);
         row <= std::min(7, pawn_row + 1); ++row) {
      for (int column = std::max(0, pawn_column - 1);
           column <= std::min(7, pawn_column + 1); ++column) {
        masks[square] |= uint64_t{1} << (row * 8 + column);
      }
    }
  }
  return masks;
}

constexpr auto kNearPawnWallMasks = MakeNearPawnWallMasks();

uint64_t AvailableWallMask(const Position& position, bool vertical) {
  const uint64_t own =
      vertical ? position.vertical_walls : position.horizontal_walls;
  const uint64_t crossing =
      vertical ? position.horizontal_walls : position.vertical_walls;
  uint64_t forbidden = own | crossing;
  if (vertical) {
    forbidden |= own << 8;
    forbidden |= own >> 8;
  } else {
    forbidden |= (own & ~kWallColumnSeven) << 1;
    forbidden |= (own & ~kWallColumnZero) >> 1;
  }
  return ~forbidden;
}

struct PathResult {
  int distance = 99;
  uint64_t blocking_horizontal = 0;
  uint64_t blocking_vertical = 0;
};

constexpr std::size_t kPathCacheSize = 1U << 15;

struct PathCacheEntry {
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  PathResult result;
  uint8_t pawn = 0;
  uint8_t player = 0;
  bool valid = false;
};

std::array<PathCacheEntry, kPathCacheSize> path_cache;
// Empty openings have cheap, low-collision BFS traversals where hashing costs
// more than recomputation. Each worker owns one Wasm instance and one search,
// so root-phase specialization is thread-safe and remains exact.
bool path_cache_enabled = false;

struct TopologyCacheEntry {
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  std::array<std::array<uint8_t, kSquareCount>, 2> distances{};
  uint8_t observations = 0;
  bool ready = false;
};

std::array<TopologyCacheEntry, kTopologyCacheSize> topology_cache;

// Phase-three topology entries deliberately exclude pawn squares. A wall
// layout defines the board graph, so one pair of reverse distance fields can
// serve every pawn position reached while that topology remains unchanged.
// Admission occurs only after the layout is encountered again; one-off wall
// children continue using the cheaper direct path search.
struct TopologyV3Entry {
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  std::array<std::array<uint8_t, kSquareCount>, 2> distances{};
  uint8_t observations = 0;
  bool ready = false;
};

std::array<TopologyV3Entry, kTopologyCacheSize> topology_v3_cache;
uint32_t experiment_mask = 0;

struct MoveList {
  int count = 0;
  std::array<uint16_t, 136> moves{};

  void Push(uint16_t move) { moves[count++] = move; }
};

struct SearchMove {
  uint16_t move;
};

struct SearchMoveList {
  int count = 0;
  // Only [0, count) is ever observed. Leaving the fixed backing storage
  // uninitialized avoids clearing 1 KiB of stack data at every search node.
  std::array<SearchMove, 136> moves;
  std::array<uint16_t, 136> order;
  std::array<int, 136> priorities;

  void Push(uint16_t move) {
    moves[count] = {move};
    order[count] = static_cast<uint16_t>(count);
    ++count;
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
  int selective_depth = 0;
  int verified_depth = 0;
  int sel_depth = 0;
  int pv_length = 0;
  std::array<uint16_t, kMaximumPvLength> pv{};
  uint64_t nodes = 0;
  uint64_t transposition_hits = 0;
  uint64_t verifier_nodes = 0;
  uint64_t leaf_nodes = 0;
  uint64_t cutoffs = 0;
  uint64_t reduced_searches = 0;
  uint64_t researches = 0;
  uint64_t pruned_moves = 0;
  uint64_t reverse_futility_cuts = 0;
  uint64_t razoring_cuts = 0;
  uint64_t probcut_cuts = 0;
  uint64_t history_prunes = 0;
  uint64_t multicut_cuts = 0;
  uint64_t singular_extensions = 0;
  uint64_t forced_defense_extensions = 0;
  uint64_t exact_endgame_hits = 0;
  uint64_t reused_nodes = 0;
  uint64_t canonical_transposition_hits = 0;
  uint64_t topology_cache_hits = 0;
  uint64_t topology_repairs = 0;
  int resumed_depth = 0;
  int proof_outcome = 0;
  int proof_distance = 0;
  int nps = 0;
  int time_ms = 0;
  const char* stop_reason = "depth";
  const char* score_bound = "exact";
  bool selective = false;
};

struct ZeroWallCacheEntry {
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  std::array<int8_t, kPawnStateCount> outcome{};
  std::array<uint16_t, kPawnStateCount> distance{};
  bool valid = false;
};

std::vector<TranspositionCluster> transposition_table(
    kTranspositionClusterCount);
std::array<ZeroWallCacheEntry, kZeroWallCacheSize> zero_wall_cache;
uint8_t transposition_generation = 0;
std::string exported_result;

struct SearchResumeState {
  Position root{};
  std::array<uint16_t, kMaximumPvLength> pv{};
  int score = 0;
  int depth = 0;
  int pv_length = 0;
  int score_volatility = 75;
  int root_index = 0;
  int root_count = 1;
  uint16_t best_move = kNoMove;
  bool valid = false;
};

struct EngineContext {
  std::array<std::array<int, kMoveHistorySize>, 2> history{};
  std::array<std::array<uint16_t, 2>, kMaximumSearchPly> killers{};
  std::array<std::array<int16_t, kMoveHistorySize>, kMoveHistorySize>
      continuation_history{};
  std::array<std::array<uint16_t, kMoveHistorySize>, 2> countermoves{};
  std::array<std::array<int16_t, 128>, 2> tactical_wall_history{};
  std::array<int16_t, kCorrectionHistorySize> correction_history{};
  std::array<SearchResumeState, 2> resume{};
  Position last_root{};
  bool has_last_root = false;
  uint64_t searches = 0;

  EngineContext() {
    for (auto& ply_killers : killers) {
      ply_killers = {kNoMove, kNoMove};
    }
    for (auto& player_countermoves : countermoves) {
      player_countermoves.fill(kNoMove);
    }
  }
};

EngineContext engine_context;
struct QuantizedPolicy {
  std::array<std::vector<int16_t>, 3> weights;
  std::array<std::vector<int16_t>, 3> biases;
  bool valid = false;
};
QuantizedPolicy learned_policy;
struct QuantizedValue {
  std::array<std::vector<int16_t>, 3> weights;
  std::array<std::vector<int16_t>, 3> biases;
  bool valid = false;
};
QuantizedValue learned_value;
uint64_t active_topology_cache_hits = 0;
uint64_t active_topology_repairs = 0;

#ifdef __EMSCRIPTEN__
EM_JS(void, EmitProgress, (const char* json), {
  const callback = globalThis.__walwukProgress;
  if (typeof callback === "function") callback(UTF8ToString(json));
});
#else
void EmitProgress(const char*) {}
#endif

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

uint16_t MirrorMove(uint16_t move) {
  if (!IsWallMove(move)) {
    const int square = MoveSquare(move);
    return PackPawnMove((square / 9) * 9 + (8 - square % 9));
  }
  const int id = WallId(move);
  return PackWallMove(id / 8, 7 - id % 8, IsVerticalWall(move));
}

constexpr uint64_t MirrorWallMask(uint64_t walls) {
  walls = ((walls >> 1) & 0x5555555555555555ULL) |
          ((walls & 0x5555555555555555ULL) << 1);
  walls = ((walls >> 2) & 0x3333333333333333ULL) |
          ((walls & 0x3333333333333333ULL) << 2);
  return ((walls >> 4) & 0x0f0f0f0f0f0f0f0fULL) |
         ((walls & 0x0f0f0f0f0f0f0f0fULL) << 4);
}

static_assert(MirrorWallMask(0x0000000000000001ULL) ==
              0x0000000000000080ULL);
static_assert(MirrorWallMask(MirrorWallMask(0x0123456789abcdefULL)) ==
              0x0123456789abcdefULL);

bool IsLeftRightSymmetric(const Position& position) {
  return position.pawns[0] % 9 == 4 && position.pawns[1] % 9 == 4 &&
         MirrorWallMask(position.horizontal_walls) ==
             position.horizontal_walls &&
         MirrorWallMask(position.vertical_walls) == position.vertical_walls;
}

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

void ClearEngineContext() {
  engine_context = EngineContext{};
  for (TranspositionCluster& cluster : transposition_table) {
    for (TranspositionEntry& entry : cluster.entries) entry = {};
  }
  path_cache.fill({});
  topology_cache.fill({});
  topology_v3_cache.fill({});
  zero_wall_cache.fill({});
  transposition_generation = 0;
  active_topology_cache_hits = 0;
  active_topology_repairs = 0;
}

uint32_t ReadU32(const uint8_t** cursor, const uint8_t* end, bool* valid) {
  if (end - *cursor < 4) {
    *valid = false;
    return 0;
  }
  const uint32_t value = static_cast<uint32_t>((*cursor)[0]) |
                         static_cast<uint32_t>((*cursor)[1]) << 8 |
                         static_cast<uint32_t>((*cursor)[2]) << 16 |
                         static_cast<uint32_t>((*cursor)[3]) << 24;
  *cursor += 4;
  return value;
}

bool LoadPolicy(const uint8_t* data, int size) {
  learned_policy = {};
  if (data == nullptr || size < 12 || data[0] != 'W' || data[1] != 'L' ||
      data[2] != 'P' || data[3] != 'Y') {
    return false;
  }
  const uint8_t* cursor = data + 4;
  const uint8_t* end = data + size;
  bool valid = true;
  const uint32_t version = ReadU32(&cursor, end, &valid);
  const uint32_t tensors = ReadU32(&cursor, end, &valid);
  if (!valid || version != 2 || tensors != 6) return false;
  const std::array<std::array<uint32_t, 2>, 6> expected = {{
      {64, 16}, {64, 0}, {64, 64}, {64, 0}, {1, 64}, {1, 0},
  }};
  for (uint32_t tensor = 0; tensor < tensors; ++tensor) {
    const uint32_t dimensions = ReadU32(&cursor, end, &valid);
    if (!valid || dimensions < 1 || dimensions > 2) return false;
    const uint32_t first = ReadU32(&cursor, end, &valid);
    const uint32_t second = dimensions == 2
                                ? ReadU32(&cursor, end, &valid)
                                : 0;
    const uint32_t bytes = ReadU32(&cursor, end, &valid);
    const uint32_t values = first * (dimensions == 2 ? second : 1);
    if (!valid || first != expected[tensor][0] ||
        second != expected[tensor][1] || bytes != values * 2 ||
        end - cursor < static_cast<int>(bytes)) {
      return false;
    }
    std::vector<int16_t>& destination = tensor % 2 == 0
                                            ? learned_policy.weights[tensor / 2]
                                            : learned_policy.biases[tensor / 2];
    destination.resize(values);
    for (uint32_t index = 0; index < values; ++index) {
      destination[index] = static_cast<int16_t>(
          static_cast<uint16_t>(cursor[index * 2]) |
          static_cast<uint16_t>(cursor[index * 2 + 1]) << 8);
    }
    cursor += bytes;
  }
  learned_policy.valid = cursor == end;
  return learned_policy.valid;
}

bool LoadValue(const uint8_t* data, int size) {
  learned_value = {};
  if (data == nullptr || size < 12 || data[0] != 'W' || data[1] != 'L' ||
      data[2] != 'V' || data[3] != 'L') {
    return false;
  }
  const uint8_t* cursor = data + 4;
  const uint8_t* end = data + size;
  bool valid = true;
  const uint32_t version = ReadU32(&cursor, end, &valid);
  const uint32_t tensors = ReadU32(&cursor, end, &valid);
  if (!valid || version != 2 || tensors != 6) return false;
  const std::array<std::array<uint32_t, 2>, 6> expected = {{
      {256, 12}, {256, 0}, {32, 256}, {32, 0}, {1, 32}, {1, 0},
  }};
  for (uint32_t tensor = 0; tensor < tensors; ++tensor) {
    const uint32_t dimensions = ReadU32(&cursor, end, &valid);
    if (!valid || dimensions < 1 || dimensions > 2) return false;
    const uint32_t first = ReadU32(&cursor, end, &valid);
    const uint32_t second = dimensions == 2
                                ? ReadU32(&cursor, end, &valid)
                                : 0;
    const uint32_t bytes = ReadU32(&cursor, end, &valid);
    const uint32_t values = first * (dimensions == 2 ? second : 1);
    if (!valid || first != expected[tensor][0] ||
        second != expected[tensor][1] || bytes != values * 2 ||
        end - cursor < static_cast<int>(bytes)) {
      return false;
    }
    std::vector<int16_t>& destination = tensor % 2 == 0
                                            ? learned_value.weights[tensor / 2]
                                            : learned_value.biases[tensor / 2];
    destination.resize(values);
    for (uint32_t index = 0; index < values; ++index) {
      destination[index] = static_cast<int16_t>(
          static_cast<uint16_t>(cursor[index * 2]) |
          static_cast<uint16_t>(cursor[index * 2 + 1]) << 8);
    }
    cursor += bytes;
  }
  learned_value.valid = cursor == end;
  return learned_value.valid;
}

template <std::size_t InputCount, std::size_t OutputCount>
std::array<int32_t, OutputCount> PolicyLayer(
    const std::array<int32_t, InputCount>& inputs,
    const std::vector<int16_t>& weights,
    const std::vector<int16_t>& biases, bool relu) {
  std::array<int32_t, OutputCount> outputs{};
  for (std::size_t output = 0; output < OutputCount; ++output) {
    int64_t sum = static_cast<int64_t>(biases[output]) << 10;
    for (std::size_t input = 0; input < InputCount; ++input) {
      sum += static_cast<int64_t>(inputs[input]) *
             weights[output * InputCount + input];
    }
    int32_t value = static_cast<int32_t>(std::clamp<int64_t>(
        sum >> 10, -1'000'000, 1'000'000));
    if (relu && value < 0) value = 0;
    outputs[output] = value;
  }
  return outputs;
}

bool RelatedRoot(const Position& previous, const Position& current) {
  if (previous.horizontal_walls == current.horizontal_walls &&
      previous.vertical_walls == current.vertical_walls &&
      previous.pawns == current.pawns && previous.walls_left == current.walls_left &&
      previous.turn == current.turn) {
    return true;
  }
  if (previous.turn == current.turn) return false;
  const int wall_changes = __builtin_popcountll(
      previous.horizontal_walls ^ current.horizontal_walls) +
      __builtin_popcountll(previous.vertical_walls ^ current.vertical_walls);
  const int pawn_changes = (previous.pawns[0] != current.pawns[0]) +
                           (previous.pawns[1] != current.pawns[1]);
  const int reserve_changes =
      (previous.walls_left[0] != current.walls_left[0]) +
      (previous.walls_left[1] != current.walls_left[1]);
  return (wall_changes == 0 && pawn_changes == 1 && reserve_changes == 0) ||
         (wall_changes == 1 && pawn_changes == 0 && reserve_changes == 1);
}

void PreparePersistentHistory(const Position& root) {
  const bool related = !engine_context.has_last_root ||
                       RelatedRoot(engine_context.last_root, root);
  if (!related) {
    engine_context.history = {};
    for (auto& killers : engine_context.killers) {
      killers = {kNoMove, kNoMove};
    }
    if ((experiment_mask & kExperimentAdvancedHistory) != 0) {
      engine_context.continuation_history = {};
      engine_context.tactical_wall_history = {};
      for (auto& counters : engine_context.countermoves) {
        counters.fill(kNoMove);
      }
    }
  }
  engine_context.last_root = root;
  engine_context.has_last_root = true;
  if ((engine_context.searches & 31U) == 31U) {
    for (auto& player_history : engine_context.history) {
      for (int& value : player_history) value /= 2;
    }
    if ((experiment_mask & kExperimentCorrectionHistory) != 0) {
      for (int16_t& value : engine_context.correction_history) {
        value = static_cast<int16_t>(value * 7 / 8);
      }
    }
    if ((experiment_mask & kExperimentAdvancedHistory) != 0) {
      for (auto& row : engine_context.continuation_history) {
        for (int16_t& value : row) {
          value = static_cast<int16_t>(value / 2);
        }
      }
      for (auto& row : engine_context.tactical_wall_history) {
        for (int16_t& value : row) {
          value = static_cast<int16_t>(value / 2);
        }
      }
    }
  }
}

struct CanonicalPosition {
  uint64_t key = 0;
  uint64_t horizontal_walls = 0;
  uint64_t vertical_walls = 0;
  uint32_t metadata = 0;
  bool mirrored = false;
};

CanonicalPosition Canonicalize(const Position& position) {
  CanonicalPosition canonical;
  canonical.mirrored =
      (experiment_mask & kExperimentCanonicalTranspositions) != 0 &&
      position.mirror_key < position.key;
  canonical.key = canonical.mirrored ? position.mirror_key : position.key;
  canonical.horizontal_walls = canonical.mirrored
                                   ? MirrorWallMask(position.horizontal_walls)
                                   : position.horizontal_walls;
  canonical.vertical_walls = canonical.mirrored
                                 ? MirrorWallMask(position.vertical_walls)
                                 : position.vertical_walls;
  if (!canonical.mirrored) {
    canonical.metadata = PositionMetadata(position);
  } else {
    canonical.metadata = static_cast<uint32_t>(position.turn) |
                         (static_cast<uint32_t>(
                              MirrorSquareId(position.pawns[0]))
                          << 1) |
                         (static_cast<uint32_t>(
                              MirrorSquareId(position.pawns[1]))
                          << 8) |
                         (static_cast<uint32_t>(position.walls_left[0]) << 15) |
                         (static_cast<uint32_t>(position.walls_left[1]) << 19);
  }
  return canonical;
}

std::size_t PositionIndex(const CanonicalPosition& position) {
  return static_cast<std::size_t>(position.key) &
         (kTranspositionClusterCount - 1);
}

bool SamePosition(const TranspositionEntry& entry,
                  const CanonicalPosition& position,
                  uint8_t search_mode) {
  return entry.generation != 0 &&
       entry.horizontal_walls == position.horizontal_walls &&
       entry.vertical_walls == position.vertical_walls &&
         entry.metadata == position.metadata && entry.search_mode == search_mode;
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
  position->key ^= kZobrist.walls[vertical ? 1 : 0][wall_id];
  if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
    position->mirror_key ^=
        kZobrist.walls[vertical ? 1 : 0][MirrorWallId(wall_id)];
  }
  if (vertical) {
    position->vertical_walls |= uint64_t{1} << wall_id;
    position->blocked_right =
        position->blocked_right | kWallBlocked.right[wall_id];
    position->blocked_left =
        position->blocked_left | kWallBlocked.left[wall_id];
  } else {
    position->horizontal_walls |= uint64_t{1} << wall_id;
    position->blocked_down =
        position->blocked_down | kWallBlocked.down[wall_id];
    position->blocked_up = position->blocked_up | kWallBlocked.up[wall_id];
  }
}

void RemoveWallUnchecked(Position* position, int row, int column,
                         bool vertical) {
  const int wall_id = row * 8 + column;
  position->key ^= kZobrist.walls[vertical ? 1 : 0][wall_id];
  if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
    position->mirror_key ^=
        kZobrist.walls[vertical ? 1 : 0][MirrorWallId(wall_id)];
  }
  if (vertical) {
    position->vertical_walls &= ~(uint64_t{1} << wall_id);
    position->blocked_right =
        Without(position->blocked_right, kWallBlocked.right[wall_id]);
    position->blocked_left =
        Without(position->blocked_left, kWallBlocked.left[wall_id]);
  } else {
    position->horizontal_walls &= ~(uint64_t{1} << wall_id);
    position->blocked_down =
        Without(position->blocked_down, kWallBlocked.down[wall_id]);
    position->blocked_up =
        Without(position->blocked_up, kWallBlocked.up[wall_id]);
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
  position.key = ComputePositionKey(position);
  if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
    position.mirror_key = ComputeMirrorPositionKey(position);
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

PathResult ComputeShortestPath(const Position& position, int player,
                               bool all_shortest_paths) {
  WALWUK_PROFILE_INCREMENT(full_path_searches);
  const Bits81 target = player == 0 ? kTopRow : kBottomRow;
  std::array<uint64_t, kSquareCount> layer_low;
  std::array<uint32_t, kSquareCount> layer_high;
  Bits81 frontier = SquareBit(position.pawns[player]);
  Bits81 visited = frontier;
  for (int distance = 0; distance < kSquareCount; ++distance) {
    layer_low[distance] = frontier.low;
    layer_high[distance] = frontier.high;
    const Bits81 reached = frontier & target;
    if (Any(reached)) {
      PathResult result;
      result.distance = distance;
      if (!all_shortest_paths) {
        int current = FirstSquare(reached);
        for (int layer = distance; layer > 0; --layer) {
          const Bits81 previous = {layer_low[layer - 1],
                                   layer_high[layer - 1]};
          const Bits81 predecessors =
              Expand(position, SquareBit(current)) & previous;
          const int predecessor = FirstSquare(predecessors);
          AddBlockingWallCandidates(predecessor, current, &result);
          current = predecessor;
        }
        return result;
      }
      Bits81 next_layer = reached;
      for (int layer = distance; layer > 0; --layer) {
        const Bits81 previous = {layer_low[layer - 1],
                                 layer_high[layer - 1]};
        Bits81 predecessors = Expand(position, next_layer) & previous;
        Bits81 remaining_predecessors = predecessors;
        while (Any(remaining_predecessors)) {
          const int predecessor = FirstSquare(remaining_predecessors);
          remaining_predecessors.Clear(predecessor);
          Bits81 successors = Expand(position, SquareBit(predecessor)) & next_layer;
          while (Any(successors)) {
            const int successor = FirstSquare(successors);
            successors.Clear(successor);
            AddBlockingWallCandidates(predecessor, successor, &result);
          }
        }
        next_layer = predecessors;
      }
      return result;
    }
    frontier = Without(Expand(position, frontier), visited);
    if (!Any(frontier)) break;
    visited = visited | frontier;
  }
  return {};
}

std::size_t PathCacheIndex(const Position& position, int player) {
  uint64_t key = position.horizontal_walls * 0x9e3779b97f4a7c15ULL;
  key ^= position.vertical_walls * 0xbf58476d1ce4e5b9ULL;
  key ^= static_cast<uint64_t>(position.pawns[player] + player * 81) *
         0x94d049bb133111ebULL;
  key ^= key >> 29;
  return static_cast<std::size_t>(key) & (kPathCacheSize - 1);
}

bool TryTopologyV3Path(const Position& position, int player,
                       PathResult* result);

PathResult ShortestPath(const Position& position, int player,
                        bool all_shortest_paths = false) {
  if (all_shortest_paths) {
    return ComputeShortestPath(position, player, true);
  }
  if ((experiment_mask & kExperimentTopologyV3) != 0) {
    PathResult cached;
    if (TryTopologyV3Path(position, player, &cached)) return cached;
  }
  if (!path_cache_enabled) {
    return ComputeShortestPath(position, player, false);
  }
  const int wall_count = __builtin_popcountll(position.horizontal_walls) +
                         __builtin_popcountll(position.vertical_walls);
  if (wall_count < 4) {
    return ComputeShortestPath(position, player, false);
  }
  PathCacheEntry& cached = path_cache[PathCacheIndex(position, player)];
  if (cached.valid && cached.horizontal_walls == position.horizontal_walls &&
      cached.vertical_walls == position.vertical_walls &&
      cached.pawn == position.pawns[player] && cached.player == player) {
    WALWUK_PROFILE_INCREMENT(path_cache_hits);
    ++active_topology_cache_hits;
    return cached.result;
  }
  const PathResult result = ComputeShortestPath(position, player, false);
  cached.horizontal_walls = position.horizontal_walls;
  cached.vertical_walls = position.vertical_walls;
  cached.result = result;
  cached.pawn = position.pawns[player];
  cached.player = static_cast<uint8_t>(player);
  cached.valid = true;
  return result;
}

std::size_t TopologyCacheIndex(const Position& position) {
  uint64_t key = position.horizontal_walls * 0x9e3779b97f4a7c15ULL;
  key ^= position.vertical_walls * 0xbf58476d1ce4e5b9ULL;
  key ^= key >> 31;
  return static_cast<std::size_t>(key) & (kTopologyCacheSize - 1);
}

void ComputeTopologyDistances(
    const Position& position, int player,
    std::array<uint8_t, kSquareCount>* distances) {
  distances->fill(99);
  Bits81 frontier = player == 0 ? kTopRow : kBottomRow;
  Bits81 visited = frontier;
  for (int distance = 0; distance < kSquareCount && Any(frontier);
       ++distance) {
    Bits81 remaining = frontier;
    while (Any(remaining)) {
      const int square = FirstSquare(remaining);
      remaining.Clear(square);
      (*distances)[square] = static_cast<uint8_t>(distance);
    }
    frontier = Without(Expand(position, frontier), visited);
    visited = visited | frontier;
  }
}

TopologyV3Entry* ObserveTopologyV3(const Position& position) {
  TopologyV3Entry& entry =
      topology_v3_cache[TopologyCacheIndex(position)];
  const bool matches =
      entry.horizontal_walls == position.horizontal_walls &&
      entry.vertical_walls == position.vertical_walls;
  if (!matches) {
    entry = {};
    entry.horizontal_walls = position.horizontal_walls;
    entry.vertical_walls = position.vertical_walls;
  }
  if (!entry.ready && ++entry.observations >= 8) {
    ComputeTopologyDistances(position, 0, &entry.distances[0]);
    ComputeTopologyDistances(position, 1, &entry.distances[1]);
    entry.ready = true;
    ++active_topology_repairs;
  }
  return entry.ready ? &entry : nullptr;
}

bool TryTopologyV3Path(const Position& position, int player,
                       PathResult* result) {
  TopologyV3Entry* entry = ObserveTopologyV3(position);
  if (entry == nullptr) return false;
  ++active_topology_cache_hits;
  const auto& distances = entry->distances[player];
  int current = position.pawns[player];
  result->distance = distances[current];
  if (result->distance >= 99) return true;
  for (int distance = result->distance; distance > 0; --distance) {
    const int row = current / kBoardSize;
    const int column = current % kBoardSize;
    const std::array<int, 4> candidates = {
        row > 0 ? current - kBoardSize : -1,
        column > 0 ? current - 1 : -1,
        column + 1 < kBoardSize ? current + 1 : -1,
        row + 1 < kBoardSize ? current + kBoardSize : -1,
    };
    int next = -1;
    for (const int candidate : candidates) {
      if (candidate >= 0 && !Blocked(position, current, candidate) &&
          distances[candidate] == distance - 1) {
        next = candidate;
        break;
      }
    }
    if (next < 0) {
      *result = {};
      return true;
    }
    AddBlockingWallCandidates(current, next, result);
    current = next;
  }
  return true;
}

int TopologyV3Distance(const Position& position, int player) {
  TopologyV3Entry* entry = ObserveTopologyV3(position);
  if (entry == nullptr) return -1;
  ++active_topology_cache_hits;
  return entry->distances[player][position.pawns[player]];
}

int RecomputeTopologyDistance(
    const Position& position, int square, int player,
    const std::array<uint8_t, kSquareCount>& distances) {
  if ((player == 0 && square / 9 == 0) ||
      (player == 1 && square / 9 == 8)) {
    return 0;
  }
  Bits81 neighbors = Expand(position, SquareBit(square));
  int best = 99;
  while (Any(neighbors)) {
    const int neighbor = FirstSquare(neighbors);
    neighbors.Clear(neighbor);
    best = std::min(best, static_cast<int>(distances[neighbor]) + 1);
  }
  return std::min(best, 99);
}

void RepairTopologyDistances(
    const Position& child, int player, int wall_id, bool vertical,
    std::array<uint8_t, kSquareCount>* distances) {
  std::array<uint8_t, kSquareCount * 100> queue{};
  std::array<bool, kSquareCount> queued{};
  int head = 0;
  int tail = 0;
  auto enqueue = [&](int square) {
    if (queued[square]) return;
    queued[square] = true;
    queue[tail++] = static_cast<uint8_t>(square);
  };
  const int row = wall_id / 8;
  const int column = wall_id % 8;
  for (int offset = 0; offset < 2; ++offset) {
    if (vertical) {
      const int left = (row + offset) * 9 + column;
      enqueue(left);
      enqueue(left + 1);
    } else {
      const int upper = row * 9 + column + offset;
      enqueue(upper);
      enqueue(upper + 9);
    }
  }
  while (head < tail) {
    const int square = queue[head++];
    queued[square] = false;
    const int repaired =
        RecomputeTopologyDistance(child, square, player, *distances);
    if (repaired == (*distances)[square]) continue;
    (*distances)[square] = static_cast<uint8_t>(repaired);
    Bits81 neighbors = Expand(child, SquareBit(square));
    while (Any(neighbors)) {
      const int neighbor = FirstSquare(neighbors);
      neighbors.Clear(neighbor);
      enqueue(neighbor);
    }
  }
}

void SeedChildTopology(const Position& child, uint16_t move) {
  if ((experiment_mask & kExperimentTopologyCache) == 0 ||
      !IsWallMove(move)) {
    return;
  }
  Position parent = child;
  const int id = WallId(move);
  const bool vertical = IsVerticalWall(move);
  RemoveWallUnchecked(&parent, id / 8, id % 8, vertical);
  TopologyCacheEntry& parent_entry =
      topology_cache[TopologyCacheIndex(parent)];
  if (!parent_entry.ready ||
      parent_entry.horizontal_walls != parent.horizontal_walls ||
      parent_entry.vertical_walls != parent.vertical_walls) {
    return;
  }
  TopologyCacheEntry& child_entry = topology_cache[TopologyCacheIndex(child)];
  child_entry = parent_entry;
  child_entry.horizontal_walls = child.horizontal_walls;
  child_entry.vertical_walls = child.vertical_walls;
  for (int player = 0; player < 2; ++player) {
    RepairTopologyDistances(child, player, id, vertical,
                            &child_entry.distances[player]);
  }
  child_entry.ready = true;
  ++active_topology_repairs;
}

int CachedTopologyDistance(const Position& position, int player) {
  const int wall_count = __builtin_popcountll(position.horizontal_walls) +
                         __builtin_popcountll(position.vertical_walls);
  if (wall_count < 4) return -1;
  TopologyCacheEntry& entry = topology_cache[TopologyCacheIndex(position)];
  const bool matches =
      entry.horizontal_walls == position.horizontal_walls &&
      entry.vertical_walls == position.vertical_walls;
  if (!matches) {
    entry = {};
    entry.horizontal_walls = position.horizontal_walls;
    entry.vertical_walls = position.vertical_walls;
  }
  if (entry.ready) {
    ++active_topology_cache_hits;
    return entry.distances[player][position.pawns[player]];
  }
  if (++entry.observations < 8) return -1;
  ComputeTopologyDistances(position, 0, &entry.distances[0]);
  ComputeTopologyDistances(position, 1, &entry.distances[1]);
  entry.ready = true;
  ++active_topology_repairs;
  return entry.distances[player][position.pawns[player]];
}

int ShortestDistance(const Position& position, int player) {
  if ((experiment_mask & kExperimentTopologyV3) != 0) {
    const int cached = TopologyV3Distance(position, player);
    if (cached >= 0) return cached;
  }
  if ((experiment_mask & kExperimentTopologyCache) != 0) {
    const int cached = CachedTopologyDistance(position, player);
    if (cached >= 0) return cached;
  }
  const Bits81 target = player == 0 ? kTopRow : kBottomRow;
  Bits81 frontier = SquareBit(position.pawns[player]);
  Bits81 visited = frontier;
  for (int distance = 0; distance < kSquareCount; ++distance) {
    if (Any(frontier & target)) return distance;
    frontier = Without(Expand(position, frontier), visited);
    if (!Any(frontier)) break;
    visited = visited | frontier;
  }
  return 99;
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
  const int orientation = vertical ? 1 : 0;
  return (crossing_walls & (uint64_t{1} << id)) == 0 &&
         (own_walls & kWallConflicts.same_orientation[orientation][id]) == 0;
}

bool IsLegalWall(const Position& position, int row, int column,
                 bool vertical) {
  if (!IsStructurallyLegalWall(position, row, column, vertical)) return false;
  Position trial = position;
  AddWallUnchecked(&trial, row, column, vertical);
  return ShortestDistance(trial, 0) < 99 &&
         ShortestDistance(trial, 1) < 99;
}

bool WallTouchesWitness(const PathResult& path, int id, bool vertical) {
  const uint64_t candidates =
      vertical ? path.blocking_vertical : path.blocking_horizontal;
  return ((candidates >> id) & 1U) != 0;
}

uint64_t SelectiveWallMask(
    const Position& position, const std::array<PathResult, 2>& paths,
    bool vertical) {
  uint64_t candidates = vertical
                            ? paths[0].blocking_vertical |
                                  paths[1].blocking_vertical
                            : paths[0].blocking_horizontal |
                                  paths[1].blocking_horizontal;
  candidates |= kNearPawnWallMasks[position.pawns[0]] |
                kNearPawnWallMasks[position.pawns[1]];
  return candidates;
}

SearchMoveList GenerateSearchMoves(
    const Position& position, const std::array<PathResult, 2>& paths,
    SearchMode mode = SearchMode::kExhaustive,
    bool include_all_root_walls = false, int partition_index = -1,
    int partition_count = 1, bool reduce_root_symmetry = false) {
  SearchMoveList result;
  const int player = position.turn;
  const MoveList pawn_moves = LegalPawnMoves(position, player);
  for (int index = 0; index < pawn_moves.count; ++index) {
    const uint16_t move = pawn_moves.moves[index];
    if (reduce_root_symmetry && move > MirrorMove(move)) continue;
    if (partition_index >= 0 &&
        static_cast<int>(move % partition_count) != partition_index) {
      continue;
    }
    result.Push(move);
  }

  if (position.walls_left[player] == 0) return result;
  for (int orientation = 0; orientation < 2; ++orientation) {
    const bool vertical = orientation == 1;
    uint64_t candidates = AvailableWallMask(position, vertical);
    if (mode == SearchMode::kSelective && !include_all_root_walls) {
      candidates &= SelectiveWallMask(position, paths, vertical);
    }
    while (candidates != 0) {
      const int id = __builtin_ctzll(candidates);
      candidates &= candidates - 1;
      const int row = id / 8;
      const int column = id % 8;
      const uint16_t packed_move = PackWallMove(row, column, vertical);
      if (reduce_root_symmetry && packed_move > MirrorMove(packed_move)) {
        continue;
      }
      WALWUK_PROFILE_INCREMENT(wall_candidates);
      if (partition_index >= 0 &&
          static_cast<int>(packed_move % partition_count) != partition_index) {
        continue;
      }
      result.Push(packed_move);
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
    const bool vertical = orientation == 1;
    uint64_t candidates = AvailableWallMask(position, vertical);
    while (candidates != 0) {
      const int id = __builtin_ctzll(candidates);
      candidates &= candidates - 1;
      const int row = id / 8;
      const int column = id % 8;
      if (IsLegalWall(position, row, column, vertical)) {
        result.Push(PackWallMove(row, column, vertical));
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

int PawnStateIndex(int pawn_zero, int pawn_one, int turn) {
  return ((pawn_zero * kSquareCount + pawn_one) << 1) | turn;
}

void DecodePawnState(int index, int* pawn_zero, int* pawn_one, int* turn) {
  *turn = index & 1;
  const int pawns = index >> 1;
  *pawn_zero = pawns / kSquareCount;
  *pawn_one = pawns % kSquareCount;
}

std::size_t ZeroWallCacheIndex(const Position& position) {
  uint64_t key = position.horizontal_walls * 0x9e3779b97f4a7c15ULL;
  key ^= position.vertical_walls * 0xbf58476d1ce4e5b9ULL;
  key ^= key >> 31;
  return static_cast<std::size_t>(key) & (kZeroWallCacheSize - 1);
}

void SolveZeroWallTopology(const Position& topology,
                           ZeroWallCacheEntry* result) {
  result->horizontal_walls = topology.horizontal_walls;
  result->vertical_walls = topology.vertical_walls;
  result->outcome.fill(0);
  result->distance.fill(0);

  std::array<uint8_t, kPawnStateCount> remaining{};
  std::array<uint16_t, kPawnStateCount> predecessor_count{};
  Position state = topology;
  state.walls_left = {0, 0};
  for (int index = 0; index < kPawnStateCount; ++index) {
    int pawn_zero;
    int pawn_one;
    int turn;
    DecodePawnState(index, &pawn_zero, &pawn_one, &turn);
    if (pawn_zero == pawn_one || pawn_zero / 9 == 0 || pawn_one / 9 == 8) {
      continue;
    }
    state.pawns = {static_cast<uint8_t>(pawn_zero),
                   static_cast<uint8_t>(pawn_one)};
    state.turn = static_cast<uint8_t>(turn);
    const MoveList moves = LegalPawnMoves(state, turn);
    remaining[index] = static_cast<uint8_t>(moves.count);
    for (int move_index = 0; move_index < moves.count; ++move_index) {
      const int destination = MoveSquare(moves.moves[move_index]);
      const int child = turn == 0
                            ? PawnStateIndex(destination, pawn_one, 1)
                            : PawnStateIndex(pawn_zero, destination, 0);
      ++predecessor_count[child];
    }
  }

  std::array<uint32_t, kPawnStateCount + 1> offsets{};
  for (int index = 0; index < kPawnStateCount; ++index) {
    offsets[index + 1] = offsets[index] + predecessor_count[index];
  }
  std::vector<uint16_t> predecessors(offsets.back());
  std::array<uint32_t, kPawnStateCount> cursors{};
  std::copy(offsets.begin(), offsets.begin() + kPawnStateCount,
            cursors.begin());
  for (int index = 0; index < kPawnStateCount; ++index) {
    int pawn_zero;
    int pawn_one;
    int turn;
    DecodePawnState(index, &pawn_zero, &pawn_one, &turn);
    if (pawn_zero == pawn_one || pawn_zero / 9 == 0 || pawn_one / 9 == 8) {
      continue;
    }
    state.pawns = {static_cast<uint8_t>(pawn_zero),
                   static_cast<uint8_t>(pawn_one)};
    state.turn = static_cast<uint8_t>(turn);
    const MoveList moves = LegalPawnMoves(state, turn);
    for (int move_index = 0; move_index < moves.count; ++move_index) {
      const int destination = MoveSquare(moves.moves[move_index]);
      const int child = turn == 0
                            ? PawnStateIndex(destination, pawn_one, 1)
                            : PawnStateIndex(pawn_zero, destination, 0);
      predecessors[cursors[child]++] = static_cast<uint16_t>(index);
    }
  }

  std::array<uint16_t, kPawnStateCount> queue{};
  int head = 0;
  int tail = 0;
  for (int index = 0; index < kPawnStateCount; ++index) {
    int pawn_zero;
    int pawn_one;
    int turn;
    DecodePawnState(index, &pawn_zero, &pawn_one, &turn);
    if (pawn_zero == pawn_one) continue;
    const int winner = pawn_zero / 9 == 0 ? 0 : pawn_one / 9 == 8 ? 1 : -1;
    if (winner == -1) continue;
    result->outcome[index] = winner == turn ? 1 : -1;
    queue[tail++] = static_cast<uint16_t>(index);
  }

  while (head < tail) {
    const int resolved = queue[head++];
    for (uint32_t cursor = offsets[resolved]; cursor < offsets[resolved + 1];
         ++cursor) {
      const int predecessor = predecessors[cursor];
      if (result->outcome[predecessor] != 0) continue;
      if (result->outcome[resolved] < 0) {
        result->outcome[predecessor] = 1;
        result->distance[predecessor] =
            static_cast<uint16_t>(result->distance[resolved] + 1);
        queue[tail++] = static_cast<uint16_t>(predecessor);
        continue;
      }
      if (remaining[predecessor] > 0) --remaining[predecessor];
      result->distance[predecessor] = std::max(
          result->distance[predecessor],
          static_cast<uint16_t>(result->distance[resolved] + 1));
      if (remaining[predecessor] == 0) {
        result->outcome[predecessor] = -1;
        queue[tail++] = static_cast<uint16_t>(predecessor);
      }
    }
  }
  result->valid = true;
}

const ZeroWallCacheEntry& ZeroWallSolution(const Position& position) {
  ZeroWallCacheEntry& cached = zero_wall_cache[ZeroWallCacheIndex(position)];
  if (!cached.valid ||
      cached.horizontal_walls != position.horizontal_walls ||
      cached.vertical_walls != position.vertical_walls) {
    SolveZeroWallTopology(position, &cached);
  }
  return cached;
}

int Winner(const Position& position);
Position ApplyMove(const Position& position, uint16_t move);

struct ZeroWallProof {
  int outcome = 0;
  int distance = 0;
  int length = 0;
  std::array<uint16_t, kMaximumPvLength> moves{};
};

ZeroWallProof BuildZeroWallProof(Position position) {
  ZeroWallProof proof;
  if (position.walls_left[0] != 0 || position.walls_left[1] != 0) {
    return proof;
  }
  const ZeroWallCacheEntry& solution = ZeroWallSolution(position);
  int state_index = PawnStateIndex(
      position.pawns[0], position.pawns[1], position.turn);
  proof.outcome = solution.outcome[state_index];
  proof.distance = solution.distance[state_index];
  if (proof.outcome == 0) return proof;

  while (Winner(position) == -1 && proof.length < kMaximumPvLength) {
    const int current_outcome = solution.outcome[state_index];
    const int current_distance = solution.distance[state_index];
    const MoveList moves = LegalPawnMoves(position, position.turn);
    uint16_t selected = kNoMove;
    int selected_distance = current_outcome > 0 ? kInfinity : -1;
    for (int index = 0; index < moves.count; ++index) {
      const uint16_t move = moves.moves[index];
      const Position child = ApplyMove(position, move);
      const int child_index = PawnStateIndex(
          child.pawns[0], child.pawns[1], child.turn);
      const int child_outcome = solution.outcome[child_index];
      const int child_distance = solution.distance[child_index];
      const bool valid = current_outcome > 0 ? child_outcome < 0
                                             : child_outcome > 0;
      if (!valid) continue;
      const bool exact_distance = child_distance + 1 == current_distance;
      const bool better = current_outcome > 0
                              ? child_distance < selected_distance
                              : child_distance > selected_distance;
      if (selected == kNoMove || exact_distance || better) {
        selected = move;
        selected_distance = child_distance;
        if (exact_distance) break;
      }
    }
    if (selected == kNoMove) {
      proof.outcome = 0;
      proof.length = 0;
      return proof;
    }
    proof.moves[proof.length++] = selected;
    position = ApplyMove(position, selected);
    state_index = PawnStateIndex(
        position.pawns[0], position.pawns[1], position.turn);
  }
  return proof;
}

bool PrepareChildPaths(const Position& position, uint16_t move,
                        const std::array<PathResult, 2>& paths,
                        std::array<PathResult, 2>* child_paths,
                        bool all_shortest_paths = false) {
  WALWUK_PROFILE_INCREMENT(child_paths_prepared);
  *child_paths = paths;
  if (!IsWallMove(move)) {
    const int moved_player = 1 - position.turn;
    (*child_paths)[moved_player] =
        ShortestPath(position, moved_player, all_shortest_paths);
    return true;
  }
  SeedChildTopology(position, move);
  const int id = WallId(move);
  const bool vertical = IsVerticalWall(move);
  for (int player = 0; player < 2; ++player) {
    if (!WallTouchesWitness(paths[player], id, vertical)) continue;
    (*child_paths)[player] =
        ShortestPath(position, player, all_shortest_paths);
    if ((*child_paths)[player].distance >= 99) {
      WALWUK_PROFILE_INCREMENT(illegal_walls);
      return false;
    }
  }
  return true;
}

int LegalPawnMoveCount(const Position& position, int player) {
  int count = 0;
  const int own = position.pawns[player];
  const int other = position.pawns[1 - player];
  const int own_row = own / 9;
  const int own_column = own % 9;
  for (int direction = 0; direction < 4; ++direction) {
    const int row = own_row + kRowDirections[direction];
    const int column = own_column + kColumnDirections[direction];
    if (!Inside(row, column)) continue;
    const int adjacent = row * 9 + column;
    if (Blocked(position, own, adjacent)) continue;
    if (adjacent != other) {
      ++count;
      continue;
    }

    const int beyond_row = row + kRowDirections[direction];
    const int beyond_column = column + kColumnDirections[direction];
    if (Inside(beyond_row, beyond_column)) {
      const int beyond = beyond_row * 9 + beyond_column;
      if (!Blocked(position, other, beyond)) {
        ++count;
        continue;
      }
    }

    if (kRowDirections[direction] == 0) {
      for (const int side_row : {-1, 1}) {
        const int diagonal_row = row + side_row;
        if (Inside(diagonal_row, column) &&
            !Blocked(position, other, diagonal_row * 9 + column)) {
          ++count;
        }
      }
    } else {
      for (const int side_column : {-1, 1}) {
        const int diagonal_column = column + side_column;
        if (Inside(row, diagonal_column) &&
            !Blocked(position, other, row * 9 + diagonal_column)) {
          ++count;
        }
      }
    }
  }
  return count;
}

void MakeMove(Position* position, uint16_t move);

Position ApplyMove(const Position& position, uint16_t move) {
  Position next = position;
  MakeMove(&next, move);
  return next;
}

void MakeMove(Position* position, uint16_t move) {
  const int player = position->turn;
  if (IsWallMove(move)) {
    const int id = WallId(move);
    AddWallUnchecked(position, id / 8, id % 8, IsVerticalWall(move));
    position->key ^= kZobrist.reserves[player][position->walls_left[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.reserves[player][position->walls_left[player]];
    }
    --position->walls_left[player];
    position->key ^= kZobrist.reserves[player][position->walls_left[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.reserves[player][position->walls_left[player]];
    }
  } else {
    position->key ^= kZobrist.pawns[player][position->pawns[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.pawns[player][MirrorSquareId(position->pawns[player])];
    }
    position->pawns[player] = static_cast<uint8_t>(MoveSquare(move));
    position->key ^= kZobrist.pawns[player][position->pawns[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.pawns[player][MirrorSquareId(position->pawns[player])];
    }
  }
  position->key ^= kZobrist.turn;
  if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
    position->mirror_key ^= kZobrist.turn;
  }
  position->turn = static_cast<uint8_t>(1 - player);
}

void UnmakeMove(Position* position, uint16_t move, uint8_t original_pawn) {
  position->key ^= kZobrist.turn;
  if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
    position->mirror_key ^= kZobrist.turn;
  }
  position->turn = static_cast<uint8_t>(1 - position->turn);
  const int player = position->turn;
  if (IsWallMove(move)) {
    const int id = WallId(move);
    RemoveWallUnchecked(position, id / 8, id % 8, IsVerticalWall(move));
    position->key ^= kZobrist.reserves[player][position->walls_left[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.reserves[player][position->walls_left[player]];
    }
    ++position->walls_left[player];
    position->key ^= kZobrist.reserves[player][position->walls_left[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.reserves[player][position->walls_left[player]];
    }
  } else {
    position->key ^= kZobrist.pawns[player][position->pawns[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.pawns[player][MirrorSquareId(position->pawns[player])];
    }
    position->pawns[player] = original_pawn;
    position->key ^= kZobrist.pawns[player][position->pawns[player]];
    if ((experiment_mask & kExperimentCanonicalTranspositions) != 0) {
      position->mirror_key ^=
          kZobrist.pawns[player][MirrorSquareId(position->pawns[player])];
    }
  }
}

int Winner(const Position& position) {
  if (position.pawns[0] / 9 == 0) return 0;
  if (position.pawns[1] / 9 == 8) return 1;
  return -1;
}

int StrategicAdjustment(const Position& position, int periwinkle_distance,
                        int blossom_distance) {
  const int periwinkle_progress =
      std::clamp(8 - periwinkle_distance, 0, 8);
  const int blossom_progress = std::clamp(8 - blossom_distance, 0, 8);
  const int total_progress = periwinkle_progress + blossom_progress;
  const int periwinkle_spent = 10 - position.walls_left[0];
  const int blossom_spent = 10 - position.walls_left[1];
  const int periwinkle_premature =
      std::max(0, periwinkle_spent * 2 - total_progress);
  const int blossom_premature =
      std::max(0, blossom_spent * 2 - total_progress);
  int adjustment = (blossom_premature - periwinkle_premature) * 7;

  // Tempo matters in a pure race, but remains worth much less than one path
  // step so it cannot overrule an actual distance advantage.
  adjustment += position.turn == 0 ? 16 : -16;
  if (position.walls_left[0] == 0 && position.walls_left[1] >= 2) {
    adjustment -= 24 + 4 * position.walls_left[1];
  }
  if (position.walls_left[1] == 0 && position.walls_left[0] >= 2) {
    adjustment += 24 + 4 * position.walls_left[0];
  }

  const int pawn_gap = std::abs(static_cast<int>(position.pawns[0]) -
                                static_cast<int>(position.pawns[1]));
  if (pawn_gap == 1 || pawn_gap == 9) {
    adjustment += position.turn == 0 ? 8 : -8;
  }
  return adjustment;
}

int LearnedValueScore(const Position& position, int periwinkle_distance,
                      int blossom_distance) {
  if (!learned_value.valid ||
      (experiment_mask & kExperimentLearnedValue) == 0) {
    return 0;
  }
  const int q = 1024;
  const std::array<int32_t, 12> inputs = {
      periwinkle_distance * q / 20,
      blossom_distance * q / 20,
      position.walls_left[0] * q / 10,
      position.walls_left[1] * q / 10,
      position.turn * q,
      LegalPawnMoveCount(position, position.turn) * q / 8,
      LegalPawnMoveCount(position, 1 - position.turn) * q / 8,
      (position.pawns[0] / 9) * q / 8,
      (position.pawns[0] % 9) * q / 8,
      (position.pawns[1] / 9) * q / 8,
      (position.pawns[1] % 9) * q / 8,
      (position.walls_left[0] + position.walls_left[1]) * q / 20,
  };
  const auto hidden_one = PolicyLayer<12, 256>(
      inputs, learned_value.weights[0], learned_value.biases[0], true);
  const auto hidden_two = PolicyLayer<256, 32>(
      hidden_one, learned_value.weights[1], learned_value.biases[1], true);
  const auto output = PolicyLayer<32, 1>(
      hidden_two, learned_value.weights[2], learned_value.biases[2], false);
  return std::clamp(output[0] * 1000 / q, -1000, 1000);
}

int CorrectionValue(const Position& position) {
  if ((experiment_mask & kExperimentCorrectionHistory) == 0) return 0;
  return engine_context.correction_history[
      static_cast<std::size_t>(position.key) & (kCorrectionHistorySize - 1)];
}

int StaticEvaluation(const Position& position) {
  const int winner = Winner(position);
  if (winner != -1) return winner == position.turn ? kWin : -kWin;
  const int periwinkle = ShortestDistance(position, 0);
  const int blossom = ShortestDistance(position, 1);
  const int path_score = (blossom - periwinkle) * 100;
  const int wall_score = WallReserveValue(position.walls_left[0]) -
                         WallReserveValue(position.walls_left[1]);
  const int mobility =
      (LegalPawnMoveCount(position, 0) - LegalPawnMoveCount(position, 1)) *
      4;
  const int strategic =
      (experiment_mask & kExperimentStrategicEvaluator) != 0
          ? StrategicAdjustment(position, periwinkle, blossom)
          : 0;
  const int absolute = path_score + wall_score + mobility + strategic;
  int perspective = position.turn == 0 ? absolute : -absolute;
  if (learned_value.valid &&
      (experiment_mask & kExperimentLearnedValue) != 0) {
    perspective = (perspective * 3 +
                   LearnedValueScore(position, periwinkle, blossom)) / 4;
  }
  return perspective + CorrectionValue(position);
}

int StaticEvaluation(const Position& position,
                     const std::array<PathResult, 2>& paths) {
  const int winner = Winner(position);
  if (winner != -1) return winner == position.turn ? kWin : -kWin;
  const int path_score = (paths[1].distance - paths[0].distance) * 100;
  const int wall_score = WallReserveValue(position.walls_left[0]) -
                         WallReserveValue(position.walls_left[1]);
  const int mobility =
      (LegalPawnMoveCount(position, 0) - LegalPawnMoveCount(position, 1)) *
      4;
  const int strategic =
      (experiment_mask & kExperimentStrategicEvaluator) != 0
          ? StrategicAdjustment(position, paths[0].distance,
                                paths[1].distance)
          : 0;
  const int absolute = path_score + wall_score + mobility + strategic;
  int perspective = position.turn == 0 ? absolute : -absolute;
  if (learned_value.valid &&
      (experiment_mask & kExperimentLearnedValue) != 0) {
    perspective = (perspective * 3 +
                   LearnedValueScore(position, paths[0].distance,
                                     paths[1].distance)) / 4;
  }
  return perspective + CorrectionValue(position);
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
         << ",\"selectiveDepth\":" << result.selective_depth
         << ",\"verifiedDepth\":" << result.verified_depth
         << ",\"selDepth\":" << result.sel_depth
         << ",\"pv\":[";
  for (int index = 0; index < result.pv_length; ++index) {
    if (index != 0) output << ',';
    output << MoveJson(result.pv[index]);
  }
  output << "],\"nodes\":" << result.nodes
         << ",\"verifierNodes\":" << result.verifier_nodes
         << ",\"nps\":" << result.nps
         << ",\"timeMs\":" << result.time_ms << ",\"ttHits\":"
         << result.transposition_hits
         << ",\"leafNodes\":" << result.leaf_nodes
         << ",\"cutoffs\":" << result.cutoffs
         << ",\"reducedSearches\":" << result.reduced_searches
         << ",\"researches\":" << result.researches
         << ",\"prunedMoves\":" << result.pruned_moves
         << ",\"reverseFutilityCuts\":" << result.reverse_futility_cuts
         << ",\"razoringCuts\":" << result.razoring_cuts
         << ",\"probCutCuts\":" << result.probcut_cuts
         << ",\"historyPrunes\":" << result.history_prunes
         << ",\"multiCutCuts\":" << result.multicut_cuts
         << ",\"singularExtensions\":" << result.singular_extensions
         << ",\"forcedDefenseExtensions\":"
         << result.forced_defense_extensions
         << ",\"exactEndgameHits\":" << result.exact_endgame_hits
         << ",\"reusedNodes\":" << result.reused_nodes
         << ",\"canonicalTtHits\":"
         << result.canonical_transposition_hits
         << ",\"topologyCacheHits\":" << result.topology_cache_hits
         << ",\"topologyRepairs\":" << result.topology_repairs
         << ",\"resumedDepth\":" << result.resumed_depth
         << ",\"engineVersion\":\"" << kEngineVersion << "\""
         << ",\"evaluatorVersion\":\""
         << (learned_value.valid &&
                     (experiment_mask & kExperimentLearnedValue) != 0
                 ? "learned-value-q10-v2-experiment"
                 : (experiment_mask & kExperimentStrategicEvaluator) != 0
                 ? "strategic-v1-experiment"
                 : kEvaluatorVersion)
         << "\""
         << ",\"policyVersion\":\""
         << (learned_policy.valid
                 ? "learned-policy-q10-v2"
                 : (experiment_mask & kExperimentAdvancedHistory) != 0
                 ? "history-v2-experiment"
                 : kPolicyVersion)
         << "\""
         << ",\"experimentMask\":" << experiment_mask
         << ",\"selective\":" << (result.selective ? "true" : "false")
         << ",\"confidence\":\""
         << (result.verified_depth > 0 || result.proof_outcome != 0
                 ? "verified"
                 : "provisional")
         << "\""
         << ",\"stopReason\":\""
         << result.stop_reason << "\",\"bound\":\""
         << result.score_bound << "\",\"backend\":\"wasm\"";
  if (result.proof_outcome != 0) {
    output << ",\"proof\":{\"outcome\":\""
           << (result.proof_outcome > 0 ? "win" : "loss")
           << "\",\"distance\":" << result.proof_distance
           << ",\"solver\":\"zero-wall\",\"certificate\":[";
    for (int index = 0; index < result.pv_length; ++index) {
      if (index != 0) output << ',';
      output << MoveJson(result.pv[index]);
    }
    output << "]}";
  }
#ifdef WALWUK_PROFILE
  output << ",\"profile\":{\"fullPathSearches\":"
         << profiling.full_path_searches << ",\"pathCacheHits\":"
         << profiling.path_cache_hits << ",\"wallCandidates\":"
         << profiling.wall_candidates << ",\"childPathsPrepared\":"
         << profiling.child_paths_prepared << ",\"illegalWalls\":"
         << profiling.illegal_walls << ",\"ttProbes\":"
         << profiling.tt_probes << '}';
#endif
  output << '}';
  return output.str();
}

class Search {
 public:
  Search(const Position& initial, int max_depth, double time_ms,
          int root_index = 0, int root_count = 1,
          bool start_new_generation = true,
          SearchMode mode = SearchMode::kExhaustive,
          uint64_t node_limit = 0)
      : initial_(initial),
        max_depth_(max_depth),
        time_ms_(time_ms),
        root_index_(root_index),
        root_count_(root_count),
        mode_(mode),
        node_limit_(node_limit),
        strict_horizon_(time_ms == -1),
        solve_zero_wall_((initial.walls_left[0] == 0 &&
                          initial.walls_left[1] == 0) ||
                          (experiment_mask & kExperimentZeroWallAtFrontier) !=
                              0),
        all_shortest_paths_(
            mode == SearchMode::kSelective &&
            (experiment_mask & kExperimentAllShortestRoutes) != 0) {
    path_cache_enabled = initial.horizontal_walls != 0 ||
                         initial.vertical_walls != 0;
#ifdef WALWUK_PROFILE
    profiling = {};
#endif
    started_ = Clock::now();
    last_report_ = started_;
    if (start_new_generation) BeginSearchGeneration();
    PreparePersistentHistory(initial_);
    ++engine_context.searches;
    active_topology_cache_hits = 0;
    active_topology_repairs = 0;
    completed_.selective = mode_ == SearchMode::kSelective;
    RestoreResume();
    for (auto& ply_killers : local_killers_) {
      ply_killers = {kNoMove, kNoMove};
    }
  }

  AnalysisResult Run() {
    if (initial_.walls_left[0] == 0 && initial_.walls_left[1] == 0) {
      const ZeroWallProof proof = BuildZeroWallProof(initial_);
      if (proof.outcome != 0) {
        completed_.proof_outcome = proof.outcome;
        completed_.proof_distance = proof.distance;
        completed_.score = proof.outcome > 0
                               ? kWin - proof.distance
                               : -kWin + proof.distance;
        completed_.pv_length = proof.length;
        completed_.pv = proof.moves;
        completed_.best_move = proof.length > 0 ? proof.moves[0] : kNoMove;
        ++exact_endgame_hits_;
        RefreshStatistics(&completed_);
        completed_.stop_reason = "depth";
        return completed_;
      }
    }
    std::array<PathResult, 2> root_paths = {
        ShortestPath(initial_, 0), ShortestPath(initial_, 1)};
    if (!resumed_) completed_.score = StaticEvaluation(initial_, root_paths);
    const int first_depth = resumed_ ? completed_.depth + 1 : 1;
    if (all_shortest_paths_ && first_depth > 1) {
      root_paths = {ShortestPath(initial_, 0, true),
                    ShortestPath(initial_, 1, true)};
    }
    for (int depth = first_depth; depth <= max_depth_; ++depth) {
      if (DeadlineReached()) {
        timed_out_ = true;
        break;
      }
      // Root move generation is exhaustive. Build route unions only when a
      // child can reach another selective move-generation node.
      if (all_shortest_paths_ && depth == 2) {
        root_paths = {ShortestPath(initial_, 0, true),
                      ShortestPath(initial_, 1, true)};
      }
      int alpha = -kInfinity;
      int beta = kInfinity;
      if (depth > 2) {
        const int margin = std::clamp(100 + score_volatility_, 100, 400);
        alpha = completed_.score - margin;
        beta = completed_.score + margin;
      }
      root_best_move_ = kNoMove;
      int score =
          Negamax(&initial_, root_paths, depth, alpha, beta, 0, 0, kNoMove);
      if (timed_out_) break;
      if (score <= alpha || score >= beta) {
        ++researches_;
        score = Negamax(&initial_, root_paths, depth, -kInfinity, kInfinity,
                        0, 0, kNoMove);
        if (timed_out_) break;
      }

      score_volatility_ = std::abs(score - completed_.score);
      if ((experiment_mask & kExperimentCorrectionHistory) != 0) {
        int16_t& correction = engine_context.correction_history[
            static_cast<std::size_t>(initial_.key) &
            (kCorrectionHistorySize - 1)];
        const int prediction = StaticEvaluation(initial_, root_paths);
        correction = static_cast<int16_t>(std::clamp(
            static_cast<int>(correction) + (score - prediction) / 8,
            -200, 200));
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
        completed_.depth >= max_depth_
            ? "depth"
            : node_limit_ > 0 && nodes_ >= node_limit_ ? "nodes" : "time";
    SaveResume();
    return completed_;
  }

  AnalysisResult RunRootMove(uint16_t root_move, int depth, int alpha,
                             int beta) {
    const bool child_generates_moves = all_shortest_paths_ && depth > 1;
    const std::array<PathResult, 2> root_paths = {
        ShortestPath(initial_, 0, child_generates_moves),
        ShortestPath(initial_, 1, child_generates_moves)};
    completed_.best_move = root_move;
    completed_.depth = depth > 0 ? depth - 1 : 0;
    completed_.score = StaticEvaluation(initial_, root_paths);
    completed_.pv[0] = root_move;
    completed_.pv_length = 1;

    Position root = initial_;
    SearchMoveList moves = GenerateSearchMoves(root, root_paths, mode_, true);
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

    const uint8_t original_pawn = root.pawns[root.turn];
    MakeMove(&root, root_move);
    std::array<PathResult, 2> child_paths;
    const bool legal = PrepareChildPaths(root, root_move, root_paths,
                                         &child_paths,
                                         child_generates_moves);
    UnmakeMove(&root, root_move, original_pawn);
    if (!legal) {
      completed_.best_move = kNoMove;
      completed_.pv_length = 0;
      RefreshStatistics(&completed_);
      return completed_;
    }
    return RunPreparedRootMove(root_move, child_paths, root_paths, depth,
                               alpha, beta);
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
        -Negamax(&root, child_paths, depth - 1, -beta, -alpha, 1, 0,
                 root_move);
    UnmakeMove(&root, root_move, original_pawn);
    completed_.score = score;
    completed_.depth = depth;
    completed_.score_bound = score <= alpha ? "upper"
                             : score >= beta ? "lower"
                                             : "exact";

    Position pv_position = ApplyMove(initial_, root_move);
    for (int index = 1; index < depth && index < kMaximumPvLength; ++index) {
      bool mirrored = false;
      const TranspositionEntry* entry = FindEntry(pv_position, &mirrored);
      if (entry == nullptr || entry->best_move == kNoMove) break;
      const uint16_t move =
          mirrored ? MirrorMove(entry->best_move) : entry->best_move;
      completed_.pv[completed_.pv_length++] = move;
      pv_position = ApplyMove(pv_position, move);
      if (Winner(pv_position) != -1) break;
    }
    RefreshStatistics(&completed_);
    return completed_;
  }

 private:
  using Clock = std::chrono::steady_clock;

  bool SameResumeRoot(const Position& root) const {
    return root.pawns == initial_.pawns &&
           root.walls_left == initial_.walls_left &&
           root.turn == initial_.turn &&
           root.horizontal_walls == initial_.horizontal_walls &&
           root.vertical_walls == initial_.vertical_walls;
  }

  void RestoreResume() {
    if (strict_horizon_ || node_limit_ > 0 || time_ms_ < 0) return;
    const SearchResumeState& resume =
        engine_context.resume[static_cast<int>(mode_)];
    if (!resume.valid || !SameResumeRoot(resume.root) ||
        resume.root_index != root_index_ || resume.root_count != root_count_ ||
        resume.depth <= 0 || resume.depth >= max_depth_ ||
        resume.best_move == kNoMove) {
      return;
    }
    completed_.score = resume.score;
    completed_.depth = resume.depth;
    completed_.best_move = resume.best_move;
    completed_.pv = resume.pv;
    completed_.pv_length = resume.pv_length;
    completed_.resumed_depth = resume.depth;
    score_volatility_ = resume.score_volatility;
    resumed_ = true;
  }

  void SaveResume() {
    if (strict_horizon_ || node_limit_ > 0 || time_ms_ < 0 ||
        completed_.depth <= 0 || completed_.best_move == kNoMove) {
      return;
    }
    SearchResumeState& resume =
        engine_context.resume[static_cast<int>(mode_)];
    resume.root = initial_;
    resume.score = completed_.score;
    resume.depth = completed_.depth;
    resume.best_move = completed_.best_move;
    resume.pv = completed_.pv;
    resume.pv_length = completed_.pv_length;
    resume.score_volatility = score_volatility_;
    resume.root_index = root_index_;
    resume.root_count = root_count_;
    resume.valid = true;
  }

  bool DeadlineReached() const {
    if (node_limit_ > 0 && nodes_ >= node_limit_) return true;
    if (time_ms_ < 0) return false;
    return std::chrono::duration<double, std::milli>(Clock::now() - started_)
               .count() >= time_ms_;
  }

  void RefreshStatistics(AnalysisResult* result) const {
    const double elapsed =
        std::chrono::duration<double, std::milli>(Clock::now() - started_)
            .count();
    result->nodes = nodes_;
    result->verifier_nodes = mode_ == SearchMode::kExhaustive ? nodes_ : 0;
    result->transposition_hits = transposition_hits_;
    result->leaf_nodes = leaf_nodes_;
    result->cutoffs = cutoffs_;
    result->reduced_searches = reduced_searches_;
    result->researches = researches_;
    result->pruned_moves = pruned_moves_;
    result->reverse_futility_cuts = reverse_futility_cuts_;
    result->razoring_cuts = razoring_cuts_;
    result->probcut_cuts = probcut_cuts_;
    result->history_prunes = history_prunes_;
    result->multicut_cuts = multicut_cuts_;
    result->singular_extensions = singular_extensions_;
    result->forced_defense_extensions = forced_defense_extensions_;
    result->exact_endgame_hits = exact_endgame_hits_;
    result->reused_nodes = reused_nodes_;
    result->canonical_transposition_hits = canonical_transposition_hits_;
    result->topology_cache_hits = active_topology_cache_hits;
    result->topology_repairs = active_topology_repairs;
    result->selective_depth =
        mode_ == SearchMode::kSelective ? result->depth : 0;
    result->verified_depth =
        mode_ == SearchMode::kExhaustive ? result->depth : 0;
    result->sel_depth = sel_depth_;
    result->time_ms = static_cast<int>(elapsed + 0.5);
    result->nps = static_cast<int>(nodes_ * 1000.0 / (elapsed < 1 ? 1 : elapsed));
  }

  void CheckTime() {
    if (node_limit_ > 0 && nodes_ >= node_limit_) {
      timed_out_ = true;
      return;
    }
    if ((nodes_ & 2047U) != 0) return;
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

  TranspositionEntry* FindEntry(const Position& position,
                                bool* mirrored = nullptr) {
    WALWUK_PROFILE_INCREMENT(tt_probes);
    const CanonicalPosition canonical = Canonicalize(position);
    if (mirrored != nullptr) *mirrored = canonical.mirrored;
    TranspositionCluster& cluster =
        transposition_table[PositionIndex(canonical)];
    const uint8_t search_mode = static_cast<uint8_t>(mode_);
    TranspositionEntry* best = nullptr;
    for (TranspositionEntry& entry : cluster.entries) {
      if (SamePosition(entry, canonical, search_mode) &&
          (best == nullptr || entry.depth > best->depth)) {
        best = &entry;
      }
    }
    if (best != nullptr && canonical.mirrored) {
      ++canonical_transposition_hits_;
    }
    return best;
  }

  void StoreEntry(const Position& position, int depth, int score, Bound bound,
                   uint16_t best_move, int ply) {
    const CanonicalPosition canonical = Canonicalize(position);
    TranspositionCluster& cluster =
        transposition_table[PositionIndex(canonical)];
    const uint8_t search_mode = static_cast<uint8_t>(mode_);
    TranspositionEntry* replacement = &cluster.entries[0];
    for (TranspositionEntry& candidate : cluster.entries) {
      if (SamePosition(candidate, canonical, search_mode)) {
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
    if (SamePosition(entry, canonical, search_mode) &&
        entry.depth > depth &&
        entry.bound == Bound::kExact) {
      return;
    }
    entry.horizontal_walls = canonical.horizontal_walls;
    entry.vertical_walls = canonical.vertical_walls;
    entry.metadata = canonical.metadata;
    entry.score = ScoreToTable(score, ply);
    entry.best_move = canonical.mirrored && best_move != kNoMove
                          ? MirrorMove(best_move)
                          : best_move;
    entry.depth = static_cast<uint8_t>(depth);
    entry.bound = bound;
    entry.generation = transposition_generation;
    entry.search_mode = search_mode;
  }

  int LearnedPolicyPriority(
      const Position& position, uint16_t move,
      const std::array<PathResult, 2>& paths, int legal_move_count) const {
    if (!learned_policy.valid) return 0;
    const bool wall = IsWallMove(move);
    const bool vertical = wall && IsVerticalWall(move);
    const int location = wall ? WallId(move) : MoveSquare(move);
    const int width = wall ? 8 : 9;
    const int q = 1024;
    const std::array<int32_t, 16> inputs = {
        paths[0].distance * q / 20,
        paths[1].distance * q / 20,
        position.walls_left[0] * q / 10,
        position.walls_left[1] * q / 10,
        position.turn * q,
        StaticEvaluation(position, paths) * q / 1000,
        legal_move_count * q / 136,
        LegalPawnMoveCount(position, position.turn) * q / 8,
        (position.pawns[0] / 9) * q / 8,
        (position.pawns[0] % 9) * q / 8,
        (position.pawns[1] / 9) * q / 8,
        (position.pawns[1] % 9) * q / 8,
        wall ? q : 0,
        vertical ? q : 0,
        (location / width) * q / 8,
        (location % width) * q / 8,
    };
    const auto hidden_one = PolicyLayer<16, 64>(
        inputs, learned_policy.weights[0], learned_policy.biases[0], true);
    const auto hidden_two = PolicyLayer<64, 64>(
        hidden_one, learned_policy.weights[1], learned_policy.biases[1],
        true);
    const auto output = PolicyLayer<64, 1>(
        hidden_two, learned_policy.weights[2], learned_policy.biases[2],
        false);
    return std::clamp(output[0] / 4, -100'000, 100'000);
  }

  void OrderMoves(const Position& position, SearchMoveList* moves,
                  uint16_t transposition_move,
                  const std::array<PathResult, 2>& paths, int ply,
                  uint16_t previous_move) {
    for (int index = 0; index < moves->count; ++index) {
      const uint16_t move = moves->moves[index].move;
      int priority = move == transposition_move ? 1'000'000 : 0;
      if (ply < kMaximumSearchPly) {
        const auto& killers = KillerPair(ply);
        if (move == killers[0]) priority += 150'000;
        if (move == killers[1]) priority += 100'000;
      }
      priority += HistoryValue(position.turn, MoveHistoryIndex(move));
      const int move_history_index = MoveHistoryIndex(move);
      if ((experiment_mask & kExperimentAdvancedHistory) != 0) {
        if (previous_move != kNoMove) {
          const int previous_index = MoveHistoryIndex(previous_move);
          priority += engine_context.continuation_history[previous_index]
                                                         [move_history_index];
          if (engine_context.countermoves[position.turn][previous_index] ==
              move) {
            priority += 110'000;
          }
        }
        if (IsWallMove(move)) {
          const int wall_index = WallId(move) +
                                 (IsVerticalWall(move) ? 64 : 0);
          priority += engine_context.tactical_wall_history[position.turn]
                                                        [wall_index];
        }
      }
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
        Position child = position;
        MakeMove(&child, move);
        priority +=
            (paths[position.turn].distance -
             ShortestDistance(child, position.turn)) * 160;
      } else {
        const int player = position.turn;
        const int id = WallId(move);
        const bool vertical = IsVerticalWall(move);
        if (WallTouchesWitness(paths[1 - player], id, vertical)) {
          priority += 120;
        }
        if (WallTouchesWitness(paths[player], id, vertical)) priority -= 90;
        priority -= WallReserveCost(position.walls_left[player]);
      }
      priority += LearnedPolicyPriority(position, move, paths, moves->count);
      moves->priorities[index] = priority;
    }
    if ((experiment_mask & kExperimentPartialMoveSelection) != 0) return;
    std::sort(
        moves->order.begin(), moves->order.begin() + moves->count,
        [moves](uint16_t left, uint16_t right) {
          return moves->priorities[left] != moves->priorities[right]
                     ? moves->priorities[left] > moves->priorities[right]
                     : left < right;
        });
  }

  void SelectNextMove(SearchMoveList* moves, int ordered_index) {
    if ((experiment_mask & kExperimentPartialMoveSelection) == 0) return;
    int best = ordered_index;
    for (int candidate = ordered_index + 1; candidate < moves->count;
         ++candidate) {
      const int left = moves->order[candidate];
      const int right = moves->order[best];
      if (moves->priorities[left] > moves->priorities[right] ||
          (moves->priorities[left] == moves->priorities[right] &&
           left < right)) {
        best = candidate;
      }
    }
    std::swap(moves->order[ordered_index], moves->order[best]);
  }

  bool IsRaceCritical(const std::array<PathResult, 2>& paths) const {
    const int shortest = std::min(paths[0].distance, paths[1].distance);
    const int longest = std::max(paths[0].distance, paths[1].distance);
    return shortest <= 2 || (shortest <= 3 && longest <= 4);
  }

  void RecordCutoff(int player, uint16_t move, int depth, int ply,
                    uint16_t previous_move) {
    const int bonus = depth * depth;
    int& history = HistoryValue(player, MoveHistoryIndex(move));
    history = std::min(32'000, history + bonus);
    if ((experiment_mask & kExperimentAdvancedHistory) != 0) {
      const int move_index = MoveHistoryIndex(move);
      if (previous_move != kNoMove) {
        const int previous_index = MoveHistoryIndex(previous_move);
        int updated = engine_context.continuation_history[previous_index]
                                                         [move_index] +
                      bonus;
        engine_context.continuation_history[previous_index][move_index] =
            static_cast<int16_t>(std::min(16'000, updated));
        engine_context.countermoves[player][previous_index] = move;
      }
      if (IsWallMove(move)) {
        const int wall_index = WallId(move) +
                               (IsVerticalWall(move) ? 64 : 0);
        const int updated =
            engine_context.tactical_wall_history[player][wall_index] + bonus;
        engine_context.tactical_wall_history[player][wall_index] =
            static_cast<int16_t>(std::min(16'000, updated));
      }
    }
    if (ply >= kMaximumSearchPly) return;
    auto& killers = KillerPair(ply);
    if (killers[0] == move) return;
    killers[1] = killers[0];
    killers[0] = move;
  }

  int Quiescence(Position* position,
                 const std::array<PathResult, 2>& paths, int alpha,
                 int beta, int ply, int remaining, uint16_t previous_move) {
    const int stand_pat = StaticEvaluation(*position, paths);
    if (stand_pat >= beta) return stand_pat;
    if (stand_pat > alpha) alpha = stand_pat;
    if (remaining <= 0 || !IsRaceCritical(paths)) return stand_pat;

    SearchMoveList moves = GenerateSearchMoves(
        *position, paths, SearchMode::kSelective, false);
    OrderMoves(*position, &moves, kNoMove, paths, ply, previous_move);
    int best = stand_pat;
    for (int index = 0; index < moves.count; ++index) {
      SelectNextMove(&moves, index);
      const uint16_t move = moves.moves[moves.order[index]].move;
      const bool immediate_win =
          !IsWallMove(move) &&
          ((position->turn == 0 && MoveSquare(move) / 9 == 0) ||
           (position->turn == 1 && MoveSquare(move) / 9 == 8));
      const uint8_t original_pawn = position->pawns[position->turn];
      const int moving_player = position->turn;
      MakeMove(position, move);
      std::array<PathResult, 2> child_paths;
      if (!PrepareChildPaths(*position, move, paths, &child_paths,
                             all_shortest_paths_ && remaining > 1)) {
        UnmakeMove(position, move, original_pawn);
        continue;
      }
      const int opponent = 1 - moving_player;
      const bool forced_defense = paths[opponent].distance <= 1 &&
                                  child_paths[opponent].distance > 1;
      const bool tactical_wall =
          IsWallMove(move) &&
          child_paths[opponent].distance >= paths[opponent].distance + 2;
      const bool forced_jump = !IsWallMove(move) &&
                               child_paths[moving_player].distance + 1 <
                                   paths[moving_player].distance;
      if (!immediate_win && !forced_defense && !tactical_wall &&
          !forced_jump) {
        UnmakeMove(position, move, original_pawn);
        continue;
      }
      ++nodes_;
      sel_depth_ = std::max(sel_depth_, ply + 1);
      CheckTime();
      if (timed_out_) {
        UnmakeMove(position, move, original_pawn);
        return 0;
      }
      const int score = -Quiescence(
          position, child_paths, -beta, -alpha, ply + 1, remaining - 1,
          move);
      UnmakeMove(position, move, original_pawn);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  void RecordFailedMove(int player, uint16_t move, int depth,
                        uint16_t previous_move) {
    int& history = HistoryValue(player, MoveHistoryIndex(move));
    history = std::max(-32'000, history - depth * depth);
    if ((experiment_mask & kExperimentAdvancedHistory) != 0 &&
        previous_move != kNoMove) {
      const int previous_index = MoveHistoryIndex(previous_move);
      const int move_index = MoveHistoryIndex(move);
      const int updated =
          engine_context.continuation_history[previous_index][move_index] -
          depth * depth;
      engine_context.continuation_history[previous_index][move_index] =
          static_cast<int16_t>(std::max(-16'000, updated));
    }
  }

  int& HistoryValue(int player, int move_index) {
    return strict_horizon_ ? local_history_[player][move_index]
                           : engine_context.history[player][move_index];
  }

  std::array<uint16_t, 2>& KillerPair(int ply) {
    return strict_horizon_ ? local_killers_[ply]
                           : engine_context.killers[ply];
  }

  const std::array<uint16_t, 2>& KillerPair(int ply) const {
    return strict_horizon_ ? local_killers_[ply]
                           : engine_context.killers[ply];
  }

  bool ProbeCut(Position* position, const std::array<PathResult, 2>& paths,
                SearchMoveList* moves, int search_depth, int threshold,
                int ply, int move_limit, int required_cutoffs,
                int* cutoff_score) {
    int legal_moves = 0;
    int cutoffs = 0;
    for (int index = 0;
         index < moves->count && legal_moves < move_limit; ++index) {
      const uint16_t move = moves->moves[moves->order[index]].move;
      const uint8_t original_pawn = position->pawns[position->turn];
      MakeMove(position, move);
      std::array<PathResult, 2> child_paths;
      if (!PrepareChildPaths(*position, move, paths, &child_paths,
                             all_shortest_paths_ && search_depth > 0)) {
        UnmakeMove(position, move, original_pawn);
        continue;
      }
      ++legal_moves;
      const int score =
          -Negamax(position, child_paths, search_depth, -threshold,
                   -threshold + 1, ply + 1, 0, move);
      UnmakeMove(position, move, original_pawn);
      if (timed_out_) return false;
      if (score < threshold) continue;
      *cutoff_score = score;
      if (++cutoffs >= required_cutoffs) return true;
    }
    return false;
  }

  bool IsSingularCandidate(Position* position,
                           const std::array<PathResult, 2>& paths,
                           const SearchMoveList& moves, uint16_t candidate,
                           int depth, int cached_score, int ply) {
    const int threshold = cached_score - 80 - depth * 8;
    const int verification_depth = std::max(1, (depth - 1) / 2);
    int alternatives = 0;
    for (int index = 0; index < moves.count; ++index) {
      const uint16_t move = moves.moves[moves.order[index]].move;
      if (move == candidate) continue;
      const uint8_t original_pawn = position->pawns[position->turn];
      MakeMove(position, move);
      std::array<PathResult, 2> child_paths;
      if (!PrepareChildPaths(*position, move, paths, &child_paths,
                             all_shortest_paths_ && verification_depth > 0)) {
        UnmakeMove(position, move, original_pawn);
        continue;
      }
      ++alternatives;
      const int score =
          -Negamax(position, child_paths, verification_depth, -threshold,
                   -threshold + 1, ply + 1, 0, move);
      UnmakeMove(position, move, original_pawn);
      if (timed_out_ || score >= threshold) return false;
    }
    return alternatives > 0;
  }

  int Negamax(Position* position, const std::array<PathResult, 2>& paths,
              int depth, int alpha, int beta, int ply, int extensions,
              uint16_t previous_move) {
    ++nodes_;
    sel_depth_ = std::max(sel_depth_, ply);
    CheckTime();
    if (timed_out_) return 0;
    const int winner = Winner(*position);
    if (winner != -1) {
      return winner == position->turn ? kWin - ply : -kWin + ply;
    }
    if (solve_zero_wall_ && ply > 0 && position->walls_left[0] == 0 &&
        position->walls_left[1] == 0) {
      const ZeroWallCacheEntry& solution = ZeroWallSolution(*position);
      const int state_index = PawnStateIndex(
          position->pawns[0], position->pawns[1], position->turn);
      const int outcome = solution.outcome[state_index];
      if (outcome != 0) {
        ++exact_endgame_hits_;
        const int distance = solution.distance[state_index];
        return outcome > 0 ? kWin - ply - distance
                           : -kWin + ply + distance;
      }
    }
    alpha = std::max(alpha, -kWin + ply);
    beta = std::min(beta, kWin - ply);
    if (alpha >= beta) return alpha;
    if (depth <= 0) {
      ++leaf_nodes_;
      if (mode_ == SearchMode::kSelective &&
          (experiment_mask & kExperimentQuiescence) != 0) {
        if (all_shortest_paths_) {
          const std::array<PathResult, 2> route_union_paths = {
              ShortestPath(*position, 0, true),
              ShortestPath(*position, 1, true)};
          return Quiescence(position, route_union_paths, alpha, beta, ply, 2,
                            previous_move);
        }
        return Quiescence(position, paths, alpha, beta, ply, 2,
                          previous_move);
      }
      return StaticEvaluation(*position, paths);
    }

    const bool narrow_window = beta - alpha <= 1;
    const bool stable_selective_node =
        mode_ == SearchMode::kSelective && ply > 0 && narrow_window &&
        extensions == 0 && score_volatility_ <= 120 &&
        !IsRaceCritical(paths) && paths[0].distance > 2 &&
        paths[1].distance > 2 &&
        LegalPawnMoveCount(*position, position->turn) > 1;
    const uint32_t static_pruning_mask =
        kExperimentReverseFutility | kExperimentRazoring;
    const bool needs_node_static =
        stable_selective_node && (experiment_mask & static_pruning_mask) != 0;
    const int node_static =
        needs_node_static ? StaticEvaluation(*position, paths) : 0;
    if (needs_node_static && depth <= 3 &&
        (experiment_mask & kExperimentReverseFutility) != 0 &&
        node_static - 120 * depth >= beta) {
      ++reverse_futility_cuts_;
      ++pruned_moves_;
      return node_static;
    }
    if (needs_node_static && depth <= 2 &&
        (experiment_mask & kExperimentRazoring) != 0 &&
        node_static + 180 * depth <= alpha) {
      const int razor_score =
          (experiment_mask & kExperimentQuiescence) != 0
              ? Quiescence(position, paths, alpha, beta, ply, 1,
                           previous_move)
              : node_static;
      if (razor_score <= alpha) {
        ++razoring_cuts_;
        ++pruned_moves_;
        return razor_score;
      }
    }

    // A race extension changes the remaining selective horizon. Keep those
    // nodes out of the regular TT so an entry searched with fewer extensions
    // can never stand in for a position that is entitled to more foresight.
    // A split root likewise sees only a subset of legal root moves, so its
    // score must never become a full-position cache entry.
    const bool can_use_transposition =
        extensions == 0 && !(ply == 0 && root_count_ > 1);
    bool cached_mirrored = false;
    TranspositionEntry* cached = can_use_transposition
                                     ? FindEntry(*position, &cached_mirrored)
                                     : nullptr;
    const uint16_t cached_move =
        cached == nullptr || cached->best_move == kNoMove
            ? kNoMove
            : cached_mirrored ? MirrorMove(cached->best_move)
                              : cached->best_move;
    const int original_alpha = alpha;
    // Reuse a score only when it was searched at the requested depth. A
    // deeper entry remains valuable for move ordering, but returning it here
    // would make a fixed-depth request report a score from another horizon.
    const bool has_exact_transposition =
        cached != nullptr &&
        (strict_horizon_ ? cached->depth == depth : cached->depth >= depth);
    if (has_exact_transposition) {
      ++transposition_hits_;
      if (cached->generation != transposition_generation) ++reused_nodes_;
      const int cached_score = ScoreFromTable(cached->score, ply);
      if (cached->bound == Bound::kExact) return cached_score;
      if (cached->bound == Bound::kLower) {
        if (cached_score > alpha) alpha = cached_score;
      } else if (cached_score < beta) {
        beta = cached_score;
      }
      if (alpha >= beta) return cached_score;
    }

    const bool split_root = ply == 0 && root_count_ > 1;
    SearchMoveList moves = GenerateSearchMoves(
        *position, paths, mode_, ply == 0,
        split_root ? root_index_ : -1, split_root ? root_count_ : 1,
        ply == 0 && IsLeftRightSymmetric(*position));
    OrderMoves(*position, &moves,
               has_exact_transposition ? cached_move : kNoMove,
               paths, ply, previous_move);
    if (moves.count == 0) {
      if (ply == 0) root_best_move_ = kNoMove;
      return StaticEvaluation(*position, paths);
    }

    uint16_t singular_move = kNoMove;
    if (mode_ == SearchMode::kSelective && ply > 0 && depth >= 6 &&
        extensions == 0 && !IsRaceCritical(paths) && cached != nullptr &&
        cached_move != kNoMove && cached->depth + 2 >= depth &&
        cached->bound != Bound::kUpper &&
        (experiment_mask & kExperimentSingularExtension) != 0) {
      const int cached_score = ScoreFromTable(cached->score, ply);
      if (IsSingularCandidate(position, paths, moves, cached_move,
                              depth, cached_score, ply)) {
        singular_move = cached_move;
      }
    }

    if (stable_selective_node && depth >= 5 &&
        (experiment_mask & kExperimentProbCut) != 0) {
      const int threshold = beta + 160;
      int cutoff_score = 0;
      if (ProbeCut(position, paths, &moves, depth - 3, threshold, ply,
                   4, 1, &cutoff_score)) {
        ++probcut_cuts_;
        ++pruned_moves_;
        return cutoff_score;
      }
      if (timed_out_) return 0;
    }
    if (stable_selective_node && depth >= 6 &&
        (experiment_mask & kExperimentMultiCut) != 0) {
      int cutoff_score = 0;
      if (ProbeCut(position, paths, &moves, depth - 3, beta, ply,
                   6, 3, &cutoff_score)) {
        ++multicut_cuts_;
        pruned_moves_ += 3;
        return beta;
      }
      if (timed_out_) return 0;
    }

    int best_score = -kInfinity;
    uint16_t best_move = kNoMove;
    bool searched_move = false;
    int searched_count = 0;
    std::array<uint16_t, 136> searched_moves{};
    const bool needs_static_evaluation =
        mode_ == SearchMode::kSelective && depth <= 3;
    const int static_evaluation =
        needs_static_evaluation ? StaticEvaluation(*position, paths) : 0;
    for (int index = 0; index < moves.count; ++index) {
      SelectNextMove(&moves, index);
      const int move_index = moves.order[index];
      const SearchMove& search_move = moves.moves[move_index];
      const uint16_t move = search_move.move;
      if (ply == 0 && root_count_ > 1 &&
          static_cast<int>(move % root_count_) != root_index_) {
        continue;
      }
      const bool transposition_move =
          has_exact_transposition && move == cached_move;
      const bool immediate_win =
          !IsWallMove(move) &&
          ((position->turn == 0 && MoveSquare(move) / 9 == 0) ||
           (position->turn == 1 && MoveSquare(move) / 9 == 8));
      if (stable_selective_node && depth <= 4 && searched_count >= 6 &&
          (experiment_mask & kExperimentHistoryPruning) != 0 &&
          !transposition_move && !immediate_win &&
          HistoryValue(position->turn, MoveHistoryIndex(move)) < -depth * 32 &&
          (IsWallMove(move) || searched_count >= 10)) {
        ++history_prunes_;
        ++pruned_moves_;
        continue;
      }
      if (mode_ == SearchMode::kSelective && ply > 0 &&
          IsWallMove(move) && !transposition_move && !immediate_win) {
        const int plausible_move_limit = 8 + 4 * depth;
        if (depth <= 5 && searched_count >= plausible_move_limit) {
          ++pruned_moves_;
          continue;
        }
        if (depth <= 3 && searched_count >= 4 &&
            static_evaluation + 140 * depth <= alpha) {
          ++pruned_moves_;
          continue;
        }
      }
      const uint8_t original_pawn = position->pawns[position->turn];
      const int moving_player = position->turn;
      MakeMove(position, move);
      std::array<PathResult, 2> child_paths;
      const bool child_generates_moves = all_shortest_paths_ && depth > 1;
      if (!PrepareChildPaths(*position, move, paths, &child_paths,
                             child_generates_moves)) {
        UnmakeMove(position, move, original_pawn);
        continue;
      }
      searched_move = true;
      searched_moves[searched_count] = move;
      ++searched_count;
      int next_depth = depth - 1;
      int next_extensions = extensions;
      const int opponent = 1 - moving_player;
      const bool forced_defense =
          (experiment_mask & kExperimentForcedDefenseExtension) != 0 &&
          paths[opponent].distance <= 2 &&
          child_paths[opponent].distance > paths[opponent].distance;
      const bool singular_extension = move == singular_move;
      if (mode_ == SearchMode::kSelective &&
          extensions < kMaximumRaceExtensions &&
          (IsRaceCritical(child_paths) || forced_defense ||
           singular_extension)) {
        ++next_depth;
        ++next_extensions;
        if (forced_defense) ++forced_defense_extensions_;
        if (singular_extension) ++singular_extensions_;
      }
      if (all_shortest_paths_ && next_depth > 0 &&
          !child_generates_moves) {
        child_paths = {ShortestPath(*position, 0, true),
                       ShortestPath(*position, 1, true)};
      }
      int score;
      if (searched_count == 1) {
        score = -Negamax(position, child_paths, next_depth,
                         -beta, -alpha, ply + 1, next_extensions, move);
      } else {
        int search_depth = next_depth;
        const bool reduce =
            mode_ == SearchMode::kSelective && ply > 0 && depth >= 3 &&
            searched_count > 4 && !transposition_move && !immediate_win;
        if (reduce) {
          ++reduced_searches_;
          int reduction = 1;
          if (depth >= 6 && searched_count > 10) reduction = 2;
          if ((experiment_mask &
               kExperimentConservativeAdaptiveReductions) != 0) {
            const int history =
                HistoryValue(position->turn, MoveHistoryIndex(move));
            const bool route_tactical =
                IsWallMove(move) &&
                (child_paths[opponent].distance != paths[opponent].distance ||
                 child_paths[moving_player].distance !=
                     paths[moving_player].distance);
            const bool reduce_deep_quiet =
                depth >= 6 && searched_count > 12 && history < 4000 &&
                (!IsWallMove(move) || !route_tactical);
            const bool reduce_late_quiet_wall =
                depth >= 4 && searched_count > 16 && IsWallMove(move) &&
                !route_tactical && history < 0;
            reduction =
                reduce_deep_quiet || reduce_late_quiet_wall ? 2 : 1;
            if (IsRaceCritical(paths) || history > 4000) reduction = 1;
          } else if ((experiment_mask &
                      kExperimentGuardedAdaptiveReductions) != 0) {
            const int history =
                HistoryValue(position->turn, MoveHistoryIndex(move));
            const bool route_tactical =
                IsWallMove(move) &&
                (child_paths[opponent].distance != paths[opponent].distance ||
                 child_paths[moving_player].distance !=
                     paths[moving_player].distance);
            reduction = 1 + (depth >= 6) + (searched_count > 12) +
                        (IsWallMove(move) && history < 0);
            if (route_tactical || IsRaceCritical(paths) || history > 4000) {
              --reduction;
            }
            reduction = std::clamp(reduction, 1, 2);
          } else if ((experiment_mask &
                      kExperimentAdaptiveReductions) != 0) {
            const int history =
                HistoryValue(position->turn, MoveHistoryIndex(move));
            reduction = 1 + (depth >= 6) + (searched_count > 12) +
                        (IsWallMove(move) && history < 0);
            if (IsRaceCritical(paths) || history > 4000) --reduction;
            reduction = std::clamp(reduction, 1, std::max(1, depth - 2));
          }
          const int reduced_depth =
              search_depth > reduction ? search_depth - reduction : 0;
          score = -Negamax(position, child_paths,
                           reduced_depth, -alpha - 1, -alpha, ply + 1,
                           next_extensions, move);
          if (!timed_out_ && score > alpha) {
            ++researches_;
            score = -Negamax(position, child_paths,
                             search_depth, -alpha - 1, -alpha, ply + 1,
                             next_extensions, move);
          }
        } else {
          score = -Negamax(position, child_paths,
                           search_depth, -alpha - 1, -alpha, ply + 1,
                           next_extensions, move);
        }
        if (!timed_out_ && score > alpha && score < beta) {
          ++researches_;
          score = -Negamax(position, child_paths,
                           next_depth, -beta, -alpha, ply + 1,
                           next_extensions, move);
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
        ++cutoffs_;
        for (int failed = 0; failed + 1 < searched_count; ++failed) {
          RecordFailedMove(position->turn, searched_moves[failed], depth,
                           previous_move);
        }
        RecordCutoff(position->turn, move, depth, ply, previous_move);
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
        bool mirrored = false;
        const TranspositionEntry* entry = FindEntry(position, &mirrored);
        if (entry == nullptr || entry->best_move == kNoMove) break;
        const uint16_t move =
            mirrored ? MirrorMove(entry->best_move) : entry->best_move;
        completed_.pv[completed_.pv_length++] = move;
        position = ApplyMove(position, move);
        if (Winner(position) != -1) break;
      }
      return;
    }
    Position position = initial_;
    for (int index = 0; index < depth && index < kMaximumPvLength; ++index) {
      bool mirrored = false;
      const TranspositionEntry* entry = FindEntry(position, &mirrored);
      if (entry == nullptr || entry->best_move == kNoMove) break;
      const uint16_t move =
          mirrored ? MirrorMove(entry->best_move) : entry->best_move;
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
  uint64_t node_limit_;
  bool strict_horizon_;
  bool solve_zero_wall_;
  bool all_shortest_paths_;
  bool resumed_ = false;
  Clock::time_point started_;
  Clock::time_point last_report_;
  uint64_t nodes_ = 0;
  uint64_t transposition_hits_ = 0;
  uint64_t leaf_nodes_ = 0;
  uint64_t cutoffs_ = 0;
  uint64_t reduced_searches_ = 0;
  uint64_t researches_ = 0;
  uint64_t pruned_moves_ = 0;
  uint64_t reverse_futility_cuts_ = 0;
  uint64_t razoring_cuts_ = 0;
  uint64_t probcut_cuts_ = 0;
  uint64_t history_prunes_ = 0;
  uint64_t multicut_cuts_ = 0;
  uint64_t singular_extensions_ = 0;
  uint64_t forced_defense_extensions_ = 0;
  uint64_t exact_endgame_hits_ = 0;
  uint64_t reused_nodes_ = 0;
  uint64_t canonical_transposition_hits_ = 0;
  int sel_depth_ = 0;
  int score_volatility_ = 75;
  uint16_t root_best_move_ = kNoMove;
  std::array<std::array<int, kMoveHistorySize>, 2> local_history_{};
  std::array<std::array<uint16_t, 2>, kMaximumSearchPly> local_killers_{};
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
         << StaticEvaluation(position) << ",\"pawnMoveCounts\":["
         << LegalPawnMoveCount(position, 0) << ','
         << LegalPawnMoveCount(position, 1) << "],\"pawnMoves\":[";
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
  const SearchMoveList moves = GenerateSearchMoves(position, paths);
  std::ostringstream output;
  output << "{\"moves\":[";
  bool first = true;
  for (int index = 0; index < moves.count; ++index) {
    const uint16_t move = moves.moves[index].move;
    const uint8_t original_pawn = position.pawns[position.turn];
    MakeMove(&position, move);
    std::array<PathResult, 2> child_paths;
    const bool legal = PrepareChildPaths(position, move, paths, &child_paths);
    UnmakeMove(&position, move, original_pawn);
    if (!legal) continue;
    if (!first) output << ',';
    first = false;
    output << move;
  }
  output << "]}";
  return output.str();
}

}  // namespace walwuk

extern "C" {

EMSCRIPTEN_KEEPALIVE void walwuk_clear_context() {
  walwuk::ClearEngineContext();
}

EMSCRIPTEN_KEEPALIVE void walwuk_set_experiments(uint32_t mask) {
  if (walwuk::experiment_mask == mask) return;
  walwuk::experiment_mask = mask;
  walwuk::ClearEngineContext();
}

EMSCRIPTEN_KEEPALIVE int walwuk_load_policy(const uint8_t* data, int size) {
  const bool loaded = walwuk::LoadPolicy(data, size);
  walwuk::ClearEngineContext();
  return loaded ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int walwuk_load_value(const uint8_t* data, int size) {
  const bool loaded = walwuk::LoadValue(data, size);
  walwuk::ClearEngineContext();
  return loaded ? 1 : 0;
}

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

EMSCRIPTEN_KEEPALIVE void walwuk_analyze_nodes(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high, int max_depth, double node_limit) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  const uint64_t nodes = static_cast<uint64_t>(std::max(1.0, node_limit));
  walwuk::Search search(position, max_depth, -2, 0, 1, true,
                        walwuk::SearchMode::kExhaustive, nodes);
  walwuk::exported_result = walwuk::ResultJson(search.Run());
}

EMSCRIPTEN_KEEPALIVE void walwuk_analyze_selective_nodes(
    int pawn_zero, int pawn_one, int walls_zero, int walls_one, int turn,
    uint32_t horizontal_low, uint32_t horizontal_high, uint32_t vertical_low,
    uint32_t vertical_high, int max_depth, double node_limit) {
  const walwuk::Position position = walwuk::BuildPosition(
      pawn_zero, pawn_one, walls_zero, walls_one, turn, horizontal_low,
      horizontal_high, vertical_low, vertical_high);
  const uint64_t nodes = static_cast<uint64_t>(std::max(1.0, node_limit));
  walwuk::Search search(position, max_depth, -2, 0, 1, true,
                        walwuk::SearchMode::kSelective, nodes);
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
