// Small, versioned C ABI: Python never mirrors upstream's evolving structs.
// No network, plugins, model conversion, or CPU fallback is exposed here.
#include "transcribe.h"
#include <cstring>
#include <memory>

#define LS_EXPORT extern "C" __attribute__((visibility("default")))

LS_EXPORT const char * localscribe_canary_revision() noexcept {
    return LOCALSCRIBE_CANARY_REVISION;
}
LS_EXPORT int localscribe_canary_abi() noexcept { return 1; }

LS_EXPORT int localscribe_canary_load(const char * path, void ** output) noexcept {
    if (!output) return 1;
    *output = nullptr;
    if (!path || !*path) return 1;
    try {
        transcribe_model_load_params params;
        transcribe_model_load_params_init(&params);
        params.backend = TRANSCRIBE_BACKEND_METAL;
        transcribe_model * model = nullptr;
        const auto status = transcribe_model_load_file(path, &params, &model);
        if (status != TRANSCRIBE_OK) {
            transcribe_model_free(model);
            return 2;
        }
        *output = model;
        return 0;
    } catch (...) { return 2; }
}

LS_EXPORT int localscribe_canary_transcribe(void * model, const float * pcm,
                                          int count, char * output, int capacity) noexcept {
    if (output && capacity > 0) output[0] = '\0';
    if (!model || !pcm || count <= 0 || count > 30 * 16000 || !output || capacity < 1)
        return 1;
    try {
        transcribe_session_params session_params;
        transcribe_session_params_init(&session_params);
        session_params.n_ctx = 2048;
        // n_threads=0 lets the runtime choose from the actual hardware.
        transcribe_session * raw_session = nullptr;
        const auto status = transcribe_session_init(
            static_cast<transcribe_model *>(model), &session_params, &raw_session);
        std::unique_ptr<transcribe_session, decltype(&transcribe_session_free)>
            session(raw_session, transcribe_session_free);
        if (status != TRANSCRIBE_OK) return 2;
        transcribe_run_params params;
        transcribe_run_params_init(&params);
        params.language = "en";
        const auto result = transcribe_run(session.get(), pcm, count, &params);
        if (transcribe_was_truncated(session.get())) return 4;
        if (result != TRANSCRIBE_OK) return 2;
        const char * text = transcribe_full_text(session.get());
        if (!text) return 2;
        const auto length = std::strlen(text);
        if (length >= static_cast<size_t>(capacity)) return 3;
        std::memcpy(output, text, length + 1);
        return 0;
    } catch (...) { return 2; }
}

LS_EXPORT void localscribe_canary_free(void * model) noexcept {
    try { transcribe_model_free(static_cast<transcribe_model *>(model)); }
    catch (...) { /* Worker process exit remains the final ownership boundary. */ }
}
