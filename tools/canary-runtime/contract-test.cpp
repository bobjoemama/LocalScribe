#include <cstring>
#include <cstdio>

extern "C" {
int localscribe_canary_abi();
const char * localscribe_canary_revision();
int localscribe_canary_load(const char *, void **);
int localscribe_canary_transcribe(void *, const float *, int, char *, int);
void localscribe_canary_free(void *);
}

// This checks the actual compiled ABI and failure boundary without weights,
// microphone access, GPU inference, or a network connection.
int main() {
    if (localscribe_canary_abi() != 1 || std::strlen(localscribe_canary_revision()) != 40) return 1;
    void * model = reinterpret_cast<void *>(1);
    if (localscribe_canary_load(nullptr, &model) != 1 || model != nullptr) return 2;
    if (localscribe_canary_load("", &model) != 1 || model != nullptr) return 3;
    if (localscribe_canary_load("", nullptr) != 1) return 4;
    char output[16] = "stale";
    if (localscribe_canary_transcribe(nullptr, nullptr, 0, output, 16) != 1 || *output != '\0') return 5;
    localscribe_canary_free(nullptr);
    std::puts("Canary native ABI checks passed (no model loaded)");
    return 0;
}
