#include <node_api.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <cstdlib>
#include <string>
#include <vector>

#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>

namespace {
NSString* const kBundleId = @"io.utopiasoft.cashu";
NSString* const kAgentLabel = @"io.utopiasoft.cashu.host";
NSString* const kAgentPlist = @"io.utopiasoft.cashu.host.plist";

NSString* canonical(const char* path) {
  if (!path) return nil;
  char* resolved = realpath(path, nullptr);
  if (!resolved) return nil;
  NSString* value = [NSString stringWithUTF8String:resolved];
  free(resolved);
  return value;
}

NSString* runningExecutable() {
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  if (size == 0 || size > 65536) return nil;
  std::vector<char> path(size + 1, 0);
  return _NSGetExecutablePath(path.data(), &size) == 0 ? canonical(path.data()) : nil;
}

bool trustedBundle() {
  NSBundle* bundle = NSBundle.mainBundle;
  if (![bundle.bundleIdentifier isEqualToString:kBundleId] ||
      ![bundle.bundleURL.pathExtension isEqualToString:@"app"] ||
      ![bundle.infoDictionary[@"CFBundleExecutable"] isEqualToString:@"cashU"]) return false;
  NSString* root = canonical(bundle.bundleURL.fileSystemRepresentation);
  NSURL* executable = [bundle.bundleURL URLByAppendingPathComponent:@"Contents/MacOS/cashU"];
  struct stat entry;
  if (!root || ![root.pathExtension isEqualToString:@"app"] ||
      lstat(executable.fileSystemRepresentation, &entry) != 0 || !S_ISREG(entry.st_mode)) return false;
  NSString* expected = canonical(executable.fileSystemRepresentation);
  return expected && [expected isEqualToString:runningExecutable()];
}

napi_value string(napi_env env, NSString* value) {
  napi_value result;
  napi_create_string_utf8(env, value.UTF8String ?: "", NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value fail(napi_env env, NSString* message) {
  napi_throw_error(env, nullptr, message.UTF8String ?: "Native service error");
  return nullptr;
}

SMAppService* agent() {
  if (@available(macOS 13.0, *)) return [SMAppService agentServiceWithPlistName:kAgentPlist];
  return nil;
}

napi_value identity(napi_env env, napi_callback_info) {
  if (!trustedBundle()) return fail(env, @"Untrusted app identity");
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "bundleId", string(env, NSBundle.mainBundle.bundleIdentifier));
  napi_set_named_property(env, result, "bundlePath", string(env, canonical(NSBundle.mainBundle.bundleURL.fileSystemRepresentation)));
  return result;
}

napi_value status(napi_env env, napi_callback_info) {
  if (!trustedBundle()) return fail(env, @"Untrusted app identity");
  if (@available(macOS 13.0, *)) {
    NSString* state;
    switch (agent().status) {
      case SMAppServiceStatusNotRegistered: state = @"notRegistered"; break;
      case SMAppServiceStatusEnabled: state = @"enabled"; break;
      case SMAppServiceStatusRequiresApproval: state = @"requiresApproval"; break;
      default: state = @"notFound"; break;
    }
    return string(env, state);
  }
  return fail(env, @"ServiceManagement requires macOS 13");
}

napi_value change(napi_env env, bool enable) {
  if (!trustedBundle()) return fail(env, @"Untrusted app identity");
  if (@available(macOS 13.0, *)) {
    NSError* error = nil;
    bool ok = enable ? [agent() registerAndReturnError:&error] : [agent() unregisterAndReturnError:&error];
    if (!ok) return fail(env, error.localizedDescription ?: @"ServiceManagement failed");
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
  }
  return fail(env, @"ServiceManagement requires macOS 13");
}

napi_value registerAgent(napi_env env, napi_callback_info) { return change(env, true); }
napi_value unregisterAgent(napi_env env, napi_callback_info) { return change(env, false); }

napi_value activate(napi_env env, napi_callback_info) {
  napi_value result;
  if (!trustedBundle() || !agent()) {
    napi_get_boolean(env, false, &result);
    return result;
  }
  if (@available(macOS 13.0, *)) {
    if (agent().status != SMAppServiceStatusEnabled) {
      napi_get_boolean(env, false, &result);
      return result;
    }
    NSTask* task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
    task.arguments = @[@"kickstart", [NSString stringWithFormat:@"gui/%d/%@", getuid(), kAgentLabel]];
    NSError* error = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    task.terminationHandler = ^(NSTask*) { dispatch_semaphore_signal(done); };
    bool started = [task launchAndReturnError:&error];
    if (started) {
      if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) != 0) {
        [task terminate];
        started = false;
      } else started = task.terminationStatus == 0;
    }
    napi_get_boolean(env, started, &result);
    return result;
  }
  napi_get_boolean(env, false, &result);
  return result;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"identity", nullptr, identity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"status", nullptr, status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"register", nullptr, registerAgent, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unregister", nullptr, unregisterAgent, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"activate", nullptr, activate, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
