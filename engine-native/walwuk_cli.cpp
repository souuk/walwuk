#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>

extern "C" {
void walwuk_analyze(int, int, int, int, int, uint32_t, uint32_t, uint32_t,
                    uint32_t, int, double);
void walwuk_analyze_selective(int, int, int, int, int, uint32_t, uint32_t,
                              uint32_t, uint32_t, int, double);
void walwuk_clear_context();
void walwuk_set_experiments(uint32_t);
void walwuk_root_moves(int, int, int, int, int, uint32_t, uint32_t,
                       uint32_t, uint32_t);
void walwuk_snapshot(int, int, int, int, int, uint32_t, uint32_t, uint32_t,
                     uint32_t);
const char* walwuk_result();
}

namespace {

uint64_t ParseMask(const char* text) {
  return std::strtoull(text, nullptr, 0);
}

int Usage() {
  std::cerr
      << "usage: walwuk-cli analyze <p0> <p1> <w0> <w1> <turn> <hmask> "
         "<vmask> <depth> <time-ms> <exhaustive|selective> [experiment-mask]\n"
         "       walwuk-cli snapshot <p0> <p1> <w0> <w1> <turn> <hmask> <vmask>\n"
         "       walwuk-cli root-moves <p0> <p1> <w0> <w1> <turn> <hmask> <vmask>\n";
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return Usage();
  const std::string command = argv[1];
  if (command != "analyze" && command != "snapshot" &&
      command != "root-moves") {
    return Usage();
  }
  const int expected_arguments = command == "analyze" ? 12 : 9;
  if (argc < expected_arguments) return Usage();
  const uint64_t horizontal = ParseMask(argv[7]);
  const uint64_t vertical = ParseMask(argv[8]);
  const uint32_t experiment_mask =
      command == "analyze" && argc > 12
          ? static_cast<uint32_t>(std::strtoul(argv[12], nullptr, 0))
                : 0;
  walwuk_set_experiments(experiment_mask);
  const auto position_call = [&](auto function) {
    function(std::atoi(argv[2]), std::atoi(argv[3]), std::atoi(argv[4]),
             std::atoi(argv[5]), std::atoi(argv[6]),
             static_cast<uint32_t>(horizontal),
             static_cast<uint32_t>(horizontal >> 32),
             static_cast<uint32_t>(vertical),
             static_cast<uint32_t>(vertical >> 32));
  };
  if (command == "snapshot") {
    position_call(walwuk_snapshot);
    std::cout << walwuk_result() << '\n';
    return 0;
  }
  if (command == "root-moves") {
    position_call(walwuk_root_moves);
    std::cout << walwuk_result() << '\n';
    return 0;
  }
  const auto analyze = std::string(argv[11]) == "selective"
                           ? walwuk_analyze_selective
                           : walwuk_analyze;
  analyze(std::atoi(argv[2]), std::atoi(argv[3]), std::atoi(argv[4]),
          std::atoi(argv[5]), std::atoi(argv[6]),
          static_cast<uint32_t>(horizontal),
          static_cast<uint32_t>(horizontal >> 32),
          static_cast<uint32_t>(vertical),
          static_cast<uint32_t>(vertical >> 32), std::atoi(argv[9]),
          std::strtod(argv[10], nullptr));
  std::cout << walwuk_result() << '\n';
  return 0;
}
