#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <bcrypt.h>
#include <unknwn.h>
#include <objbase.h>
#include <uiautomation.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "uiautomationcore.lib")
#pragma comment(lib, "user32.lib")

namespace {

static_assert(sizeof(void*) == 8, "LocalScribe's Windows helper must be built for x64.");

struct TargetPayload {
  DWORD process_id;
  std::string application_id;
  std::string window_fingerprint;
  bool focused_editable;
  HWND foreground_window;
};

struct PasteExpectation {
  DWORD process_id;
  std::string application_id;
  std::string window_fingerprint;
};

bool WriteStdout(std::string_view value) {
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE) return false;
  if (value.size() > std::numeric_limits<DWORD>::max()) return false;

  const DWORD value_size = static_cast<DWORD>(value.size());
  DWORD written = 0;
  return WriteFile(
             output,
             value.data(),
             value_size,
             &written,
             nullptr) != FALSE &&
         written == value_size;
}

std::string JsonEscape(std::string_view input) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string escaped;
  escaped.reserve(input.size());
  for (const unsigned char byte : input) {
    switch (byte) {
      case '"': escaped += "\\\""; break;
      case '\\': escaped += "\\\\"; break;
      case '\b': escaped += "\\b"; break;
      case '\f': escaped += "\\f"; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (byte < 0x20) {
          escaped += "\\u00";
          escaped.push_back(kHex[(byte >> 4) & 0x0f]);
          escaped.push_back(kHex[byte & 0x0f]);
        } else {
          escaped.push_back(static_cast<char>(byte));
        }
    }
  }
  return escaped;
}

bool WideToUtf8(const std::wstring& wide, std::string* utf8) {
  if (wide.empty()) return false;
  if (wide.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
    return false;
  }
  const int wide_size = static_cast<int>(wide.size());
  const int required = WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      wide.data(),
      wide_size,
      nullptr,
      0,
      nullptr,
      nullptr);
  if (required <= 0) return false;

  utf8->resize(static_cast<size_t>(required));
  return WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      wide.data(),
      wide_size,
      utf8->data(),
      required,
      nullptr,
      nullptr) == required;
}

bool ParseProcessId(std::wstring_view argument, DWORD* process_id) {
  if (argument.empty() || argument.size() > 10 ||
      argument.front() < L'1' || argument.front() > L'9') {
    return false;
  }

  std::uint64_t value = 0;
  for (const wchar_t character : argument) {
    if (character < L'0' || character > L'9') return false;
    value = (value * 10) + static_cast<std::uint64_t>(character - L'0');
    if (value > std::numeric_limits<DWORD>::max()) return false;
  }
  *process_id = static_cast<DWORD>(value);
  return *process_id != 0;
}

bool ParsePasteExpectation(
    std::wstring_view platform,
    std::wstring_view process_id,
    const std::wstring& application_id,
    std::wstring_view window_fingerprint,
    PasteExpectation* expectation) {
  if (platform != L"win32" ||
      !ParseProcessId(process_id, &expectation->process_id) ||
      !WideToUtf8(application_id, &expectation->application_id) ||
      expectation->application_id.size() > 1024 ||
      window_fingerprint.size() != 64) {
    return false;
  }

  expectation->window_fingerprint.clear();
  expectation->window_fingerprint.reserve(window_fingerprint.size());
  for (const wchar_t character : window_fingerprint) {
    if (!((character >= L'0' && character <= L'9') ||
          (character >= L'a' && character <= L'f'))) {
      return false;
    }
    expectation->window_fingerprint.push_back(static_cast<char>(character));
  }
  return true;
}

bool Sha256(std::string_view input, std::string* hexadecimal) {
  if (input.size() > std::numeric_limits<ULONG>::max()) return false;

  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_length = 0;
  DWORD digest_length = 0;
  DWORD bytes_read = 0;
  bool success = false;

  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(
          &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) {
    return false;
  }

  if (!BCRYPT_SUCCESS(BCryptGetProperty(
          algorithm,
          BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_length),
          sizeof(object_length),
          &bytes_read,
          0)) ||
      object_length == 0 ||
      !BCRYPT_SUCCESS(BCryptGetProperty(
          algorithm,
          BCRYPT_HASH_LENGTH,
          reinterpret_cast<PUCHAR>(&digest_length),
          sizeof(digest_length),
          &bytes_read,
          0)) ||
      digest_length != 32) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  std::vector<UCHAR> hash_object(object_length);
  std::vector<UCHAR> digest(digest_length);
  if (BCRYPT_SUCCESS(BCryptCreateHash(
          algorithm,
          &hash,
          hash_object.data(),
          object_length,
          nullptr,
          0,
          0)) &&
      BCRYPT_SUCCESS(BCryptHashData(
          hash,
          reinterpret_cast<PUCHAR>(const_cast<char*>(input.data())),
          static_cast<ULONG>(input.size()),
          0)) &&
      BCRYPT_SUCCESS(BCryptFinishHash(hash, digest.data(), digest_length, 0))) {
    constexpr char kHex[] = "0123456789abcdef";
    hexadecimal->clear();
    hexadecimal->reserve(digest.size() * 2);
    for (const UCHAR byte : digest) {
      hexadecimal->push_back(kHex[(byte >> 4) & 0x0f]);
      hexadecimal->push_back(kHex[byte & 0x0f]);
    }
    success = true;
  }

  if (hash != nullptr) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return success;
}

bool ProcessImagePath(DWORD process_id, std::string* path_utf8) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (process == nullptr) return false;

  // QueryFullProcessImageNameW accepts a caller-owned buffer. 32,768 UTF-16
  // code units covers the Windows extended path limit without truncation.
  std::vector<wchar_t> path(32'768);
  DWORD path_length = static_cast<DWORD>(path.size());
  const BOOL queried = QueryFullProcessImageNameW(
      process, 0, path.data(), &path_length);
  CloseHandle(process);
  if (queried == FALSE || path_length == 0 ||
      path_length >= static_cast<DWORD>(path.size())) {
    return false;
  }

  return WideToUtf8(std::wstring(path.data(), path_length), path_utf8);
}

bool IsKeyPressed(int virtual_key) {
  return (GetAsyncKeyState(virtual_key) & 0x8000) != 0;
}

bool EqualsClassName(std::wstring_view actual, std::wstring_view expected) {
  if (actual.size() != expected.size()) return false;
  return CompareStringOrdinal(
             actual.data(),
             static_cast<int>(actual.size()),
             expected.data(),
             static_cast<int>(expected.size()),
             TRUE) == CSTR_EQUAL;
}

bool StartsWithClassName(std::wstring_view actual, std::wstring_view prefix) {
  if (actual.size() < prefix.size()) return false;
  return CompareStringOrdinal(
             actual.data(),
             static_cast<int>(prefix.size()),
             prefix.data(),
             static_cast<int>(prefix.size()),
             TRUE) == CSTR_EQUAL;
}

bool NativeControlLooksEditable(HWND focus_window) {
  if (focus_window == nullptr ||
      IsWindow(focus_window) == FALSE ||
      IsWindowEnabled(focus_window) == FALSE ||
      IsWindowVisible(focus_window) == FALSE) {
    return false;
  }

  std::array<wchar_t, 256> class_name{};
  const int class_name_length = GetClassNameW(
      focus_window,
      class_name.data(),
      static_cast<int>(class_name.size()));
  if (class_name_length <= 0) return false;
  const std::wstring_view name(class_name.data(), static_cast<size_t>(class_name_length));
  const LONG_PTR style = GetWindowLongPtrW(focus_window, GWL_STYLE);

  if (EqualsClassName(name, L"Edit") || StartsWithClassName(name, L"RichEdit")) {
    return (style & ES_READONLY) == 0;
  }

  if (EqualsClassName(name, L"Scintilla")) {
    // SCI_GETREADONLY. Use a bounded cross-process query so an unresponsive
    // editor cannot strand the helper process.
    constexpr UINT kSciGetReadOnly = 2140;
    DWORD_PTR read_only = 1;
    const LRESULT delivered = SendMessageTimeoutW(
        focus_window,
        kSciGetReadOnly,
        0,
        0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        50,
        &read_only);
    return delivered != 0 && read_only == 0;
  }

  return false;
}

std::string AutomationRuntimeId(IUIAutomationElement* element) {
  SAFEARRAY* runtime_id = nullptr;
  if (FAILED(element->GetRuntimeId(&runtime_id)) || runtime_id == nullptr) return {};

  std::string descriptor;
  LONG lower_bound = 0;
  LONG upper_bound = -1;
  if (SafeArrayGetDim(runtime_id) != 1 ||
      FAILED(SafeArrayGetLBound(runtime_id, 1, &lower_bound)) ||
      FAILED(SafeArrayGetUBound(runtime_id, 1, &upper_bound)) ||
      upper_bound < lower_bound) {
    SafeArrayDestroy(runtime_id);
    return {};
  }
  const std::int64_t value_count =
      static_cast<std::int64_t>(upper_bound) -
      static_cast<std::int64_t>(lower_bound) + 1;
  if (value_count <= 0 || value_count > 64) {
    SafeArrayDestroy(runtime_id);
    return {};
  }

  for (std::int64_t offset = 0; offset < value_count; ++offset) {
    const LONG index = static_cast<LONG>(
        static_cast<std::int64_t>(lower_bound) + offset);
    int value = 0;
    LONG mutable_index = index;
    if (FAILED(SafeArrayGetElement(runtime_id, &mutable_index, &value))) {
      descriptor.clear();
      break;
    }
    if (!descriptor.empty()) descriptor.push_back(',');
    descriptor += std::to_string(value);
  }
  SafeArrayDestroy(runtime_id);
  return descriptor;
}

bool AutomationElementIsEditable(
    HWND focus_window,
    bool* editable,
    std::string* runtime_id) {
  *editable = false;
  runtime_id->clear();

  const HRESULT initialization = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool uninitialize = SUCCEEDED(initialization);
  if (FAILED(initialization) && initialization != RPC_E_CHANGED_MODE) {
    return false;
  }

  IUIAutomation* automation = nullptr;
  IUIAutomationElement* element = nullptr;
  IUIAutomationValuePattern* value_pattern = nullptr;
  bool inspected = false;

  if (SUCCEEDED(CoCreateInstance(
          CLSID_CUIAutomation,
          nullptr,
          CLSCTX_INPROC_SERVER,
          IID_PPV_ARGS(&automation))) &&
      automation != nullptr &&
      SUCCEEDED(automation->GetFocusedElement(&element)) &&
      element != nullptr) {
    *runtime_id = AutomationRuntimeId(element);

    BOOL enabled = FALSE;
    BOOL has_keyboard_focus = FALSE;
    CONTROLTYPEID control_type = 0;
    if (SUCCEEDED(element->get_CurrentIsEnabled(&enabled)) &&
        SUCCEEDED(element->get_CurrentHasKeyboardFocus(&has_keyboard_focus)) &&
        SUCCEEDED(element->get_CurrentControlType(&control_type))) {
      inspected = true;
      if (enabled != FALSE && has_keyboard_focus != FALSE) {
        if (SUCCEEDED(element->GetCurrentPatternAs(
                UIA_ValuePatternId,
                IID_PPV_ARGS(&value_pattern))) &&
            value_pattern != nullptr) {
          BOOL read_only = TRUE;
          if (SUCCEEDED(value_pattern->get_CurrentIsReadOnly(&read_only))) {
            *editable = read_only == FALSE;
          }
        }

        if (!*editable && control_type == UIA_EditControlTypeId) {
          VARIANT text_edit_available;
          VariantInit(&text_edit_available);
          if (SUCCEEDED(element->GetCurrentPropertyValue(
                  UIA_IsTextEditPatternAvailablePropertyId,
                  &text_edit_available)) &&
              text_edit_available.vt == VT_BOOL &&
              text_edit_available.boolVal == VARIANT_TRUE) {
            *editable = true;
          }
          VariantClear(&text_edit_available);
        }
      }
    }
  }

  if (value_pattern != nullptr) value_pattern->Release();
  if (element != nullptr) element->Release();
  if (automation != nullptr) automation->Release();
  if (uninitialize) CoUninitialize();

  // Native Edit/RichEdit/Scintilla controls remain usable even when a target
  // application does not expose UI Automation metadata.
  if (!*editable && NativeControlLooksEditable(focus_window)) {
    *editable = true;
    inspected = true;
  }
  return inspected;
}

bool FocusWindowForForeground(HWND foreground_window, HWND* focus_window) {
  DWORD process_id = 0;
  const DWORD thread_id = GetWindowThreadProcessId(foreground_window, &process_id);
  if (thread_id == 0 || process_id == 0) return false;

  GUITHREADINFO information{};
  information.cbSize = sizeof(information);
  if (GetGUIThreadInfo(thread_id, &information) == FALSE) return false;
  if (information.hwndActive != nullptr &&
      GetAncestor(information.hwndActive, GA_ROOT) != foreground_window) {
    return false;
  }
  *focus_window = information.hwndFocus != nullptr
      ? information.hwndFocus
      : foreground_window;
  return IsWindow(*focus_window) != FALSE;
}

bool CaptureTarget(TargetPayload* payload) {
  const HWND window = GetForegroundWindow();
  if (window == nullptr) return false;

  DWORD process_id = 0;
  if (GetWindowThreadProcessId(window, &process_id) == 0 || process_id == 0) {
    return false;
  }

  std::string application_id;
  if (!ProcessImagePath(process_id, &application_id)) return false;
  if (application_id.empty() || application_id.size() > 1024) return false;

  HWND focus_window = nullptr;
  if (!FocusWindowForForeground(window, &focus_window)) return false;
  bool focused_editable = false;
  std::string automation_runtime_id;
  AutomationElementIsEditable(
      focus_window,
      &focused_editable,
      &automation_runtime_id);

  // Querying the process path is not atomic with GetForegroundWindow. Recheck
  // the window, PID, and focused HWND before returning an identity.
  if (GetForegroundWindow() != window) return false;
  DWORD confirmed_process_id = 0;
  if (GetWindowThreadProcessId(window, &confirmed_process_id) == 0 ||
      confirmed_process_id != process_id) {
    return false;
  }
  HWND confirmed_focus_window = nullptr;
  if (!FocusWindowForForeground(window, &confirmed_focus_window) ||
      confirmed_focus_window != focus_window) {
    return false;
  }

  std::string descriptor = std::to_string(process_id);
  descriptor.push_back('\0');
  descriptor += "hwnd:";
  descriptor += std::to_string(
      static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(window)));
  descriptor.push_back('\0');
  descriptor += "focus:";
  descriptor += std::to_string(
      static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(focus_window)));
  if (!automation_runtime_id.empty()) {
    descriptor.push_back('\0');
    descriptor += "uia:";
    descriptor += automation_runtime_id;
  }

  std::string window_fingerprint;
  if (!Sha256(descriptor, &window_fingerprint)) return false;

  payload->process_id = process_id;
  payload->application_id = std::move(application_id);
  payload->window_fingerprint = std::move(window_fingerprint);
  payload->focused_editable = focused_editable;
  payload->foreground_window = window;
  return true;
}

bool TargetMatches(
    const TargetPayload& target,
    const PasteExpectation& expectation) {
  return target.process_id == expectation.process_id &&
      target.application_id == expectation.application_id &&
      target.window_fingerprint == expectation.window_fingerprint &&
      target.focused_editable;
}

bool InjectPaste(const PasteExpectation& expectation) {
  // Extra modifiers can turn Ctrl+V into another command (for example
  // Ctrl+Shift+V). Fail closed and leave the transcription on the clipboard.
  if (IsKeyPressed(VK_CONTROL) ||
      IsKeyPressed(VK_SHIFT) ||
      IsKeyPressed(VK_MENU) ||
      IsKeyPressed(VK_LWIN) ||
      IsKeyPressed(VK_RWIN)) {
    return false;
  }

  // Focus can still change in the irreducible handoff between this native
  // recapture and SendInput. Keep that interval free of asynchronous work and
  // fail closed on every identity or editability mismatch.
  TargetPayload target{};
  if (!CaptureTarget(&target) ||
      !TargetMatches(target, expectation) ||
      GetForegroundWindow() != target.foreground_window) {
    return false;
  }

  std::array<INPUT, 4> inputs{};
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].ki.wVk = VK_CONTROL;
  inputs[1].type = INPUT_KEYBOARD;
  inputs[1].ki.wVk = 'V';
  inputs[2].type = INPUT_KEYBOARD;
  inputs[2].ki.wVk = 'V';
  inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
  inputs[3].type = INPUT_KEYBOARD;
  inputs[3].ki.wVk = VK_CONTROL;
  inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;

  const UINT sent = SendInput(
      static_cast<UINT>(inputs.size()),
      inputs.data(),
      sizeof(INPUT));
  if (sent == static_cast<UINT>(inputs.size())) return true;

  // SendInput normally accepts the whole serial array or none of it. Make a
  // best-effort key-up cleanup if a provider reports a partial insertion so a
  // synthetic modifier cannot remain down.
  std::array<INPUT, 2> releases{};
  releases[0].type = INPUT_KEYBOARD;
  releases[0].ki.wVk = 'V';
  releases[0].ki.dwFlags = KEYEVENTF_KEYUP;
  releases[1].type = INPUT_KEYBOARD;
  releases[1].ki.wVk = VK_CONTROL;
  releases[1].ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(
      static_cast<UINT>(releases.size()),
      releases.data(),
      sizeof(INPUT));
  return false;
}

bool SelfTest() {
  std::string digest;
  if (!Sha256("abc", &digest) ||
      digest != "ba7816bf8f01cfea414140de5dae2223"
                "b00361a396177a9cb410ff61f20015ad") {
    return false;
  }

  const std::wstring fingerprint(64, L'a');
  PasteExpectation expectation{};
  PasteExpectation invalid{};
  if (!ParsePasteExpectation(
          L"win32",
          L"42",
          L"C:\\Program Files\\Editor\\editor.exe",
          fingerprint,
          &expectation) ||
      ParsePasteExpectation(
          L"darwin",
          L"42",
          L"C:\\Program Files\\Editor\\editor.exe",
          fingerprint,
          &invalid) ||
      ParsePasteExpectation(
          L"win32",
          L"042",
          L"C:\\Program Files\\Editor\\editor.exe",
          fingerprint,
          &invalid) ||
      ParsePasteExpectation(
          L"win32",
          L"42",
          L"C:\\Program Files\\Editor\\editor.exe",
          std::wstring(64, L'A'),
          &invalid)) {
    return false;
  }

  TargetPayload matching{
      42,
      "C:\\Program Files\\Editor\\editor.exe",
      std::string(64, 'a'),
      true,
      nullptr,
  };
  TargetPayload non_editable = matching;
  non_editable.focused_editable = false;
  return TargetMatches(matching, expectation) &&
      !TargetMatches(non_editable, expectation);
}

int Fail() {
  constexpr std::string_view message = "active-target helper failed\n";
  HANDLE error_output = GetStdHandle(STD_ERROR_HANDLE);
  if (error_output != nullptr && error_output != INVALID_HANDLE_VALUE) {
    DWORD written = 0;
    WriteFile(
        error_output,
        message.data(),
        static_cast<DWORD>(message.size()),
        &written,
        nullptr);
  }
  return 2;
}

}  // namespace

int wmain(int argument_count, wchar_t* arguments[]) {
  if (argument_count < 2) return Fail();

  if (std::wstring_view(arguments[1]) == L"clipboard-sequence") {
    if (argument_count != 2) return Fail();
    const DWORD sequence = GetClipboardSequenceNumber();
    return WriteStdout(
               "{\"sequence\":" + std::to_string(sequence) + "}\n")
        ? 0
        : Fail();
  }

  if (std::wstring_view(arguments[1]) == L"target") {
    if (argument_count != 2) return Fail();
    TargetPayload target{};
    if (!CaptureTarget(&target)) return Fail();
    const std::string json =
        "{\"platform\":\"win32\",\"processId\":" +
        std::to_string(target.process_id) +
        ",\"applicationId\":\"" + JsonEscape(target.application_id) +
        "\",\"windowFingerprint\":\"" + target.window_fingerprint +
        "\",\"focusedEditable\":" +
        (target.focused_editable ? "true" : "false") + "}\n";
    return WriteStdout(json) ? 0 : Fail();
  }

  if (std::wstring_view(arguments[1]) == L"paste") {
    if (argument_count != 6) return Fail();
    PasteExpectation expectation{};
    if (!ParsePasteExpectation(
            arguments[2],
            arguments[3],
            arguments[4],
            arguments[5],
            &expectation)) {
      return Fail();
    }
    return WriteStdout(
               InjectPaste(expectation)
                   ? "{\"injected\":true}\n"
                   : "{\"injected\":false}\n")
        ? 0
        : Fail();
  }

  if (std::wstring_view(arguments[1]) == L"self-test") {
    if (argument_count != 2) return Fail();
    if (!SelfTest()) return Fail();
    return WriteStdout(
               "{\"platform\":\"win32\",\"architecture\":\"x64\","
               "\"selfTest\":true}\n")
        ? 0
        : Fail();
  }

  return Fail();
}
