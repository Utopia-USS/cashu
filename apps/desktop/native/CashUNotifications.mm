#include <node_api.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

constexpr const char* kBundleId = "io.utopiasoft.cashu.next";
constexpr int64_t kWaitNanoseconds = 8LL * NSEC_PER_SEC;
constexpr size_t kMaxPendingResponses = 16;
std::mutex gHandlerMutex;

struct ResponsePair {
  std::string requestId;
  std::string intentToken;
};

struct HandlerGeneration {
  napi_threadsafe_function function = nullptr;
};

HandlerGeneration* gHandler = nullptr;
std::deque<ResponsePair> gPendingResponses;
bool gWakeQueued = false;

bool Matches(NSString* value, NSString* pattern) {
  if (![value isKindOfClass:NSString.class]) return false;
  NSRegularExpression* expression = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
  return [expression numberOfMatchesInString:value options:0 range:NSMakeRange(0, value.length)] == 1;
}

bool ValidRequestId(NSString* value) {
  return Matches(value, @"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
}

bool ValidToken(NSString* value) { return Matches(value, @"^[0-9a-f]{64}$"); }

bool HasExactKeys(NSDictionary* dictionary, NSArray<NSString*>* expected) {
  if (![dictionary isKindOfClass:NSDictionary.class] || dictionary.count != expected.count) return false;
  for (NSString* key in expected) if (!dictionary[key]) return false;
  return true;
}

bool IsProtocolVersionOne(id value) {
  if (![value isKindOfClass:NSNumber.class]) return false;
  CFTypeRef number = (__bridge CFTypeRef)value;
  return CFGetTypeID(number) == CFNumberGetTypeID() &&
    !CFNumberIsFloatType((__bridge CFNumberRef)value) &&
    [value longLongValue] == 1;
}

NSString* CanonicalPath(const char* path) {
  if (!path) return nil;
  char* resolved = realpath(path, nullptr);
  if (!resolved) return nil;
  NSString* result = [NSString stringWithUTF8String:resolved];
  free(resolved);
  return result;
}

NSString* RunningExecutablePath() {
  char probe[1] = {0};
  uint32_t size = sizeof(probe);
  if (_NSGetExecutablePath(probe, &size) == 0) return CanonicalPath(probe);
  if (size == 0 || size > 65536) return nil;
  std::vector<char> path(size + 1, 0);
  if (_NSGetExecutablePath(path.data(), &size) != 0) return nil;
  return CanonicalPath(path.data());
}

NSDictionary* BundleIdentity() {
  NSBundle* bundle = NSBundle.mainBundle;
  NSString* bundleId = bundle.bundleIdentifier ?: @"";
  NSURL* bundleURL = bundle.bundleURL;
  NSString* name = bundle.infoDictionary[@"CFBundleExecutable"];
  if (![name isKindOfClass:NSString.class]) name = @"";
  NSURL* executableURL = [[bundleURL URLByAppendingPathComponent:@"Contents/MacOS" isDirectory:YES]
    URLByAppendingPathComponent:name isDirectory:NO];
  bool validName = name.length > 0 && [name rangeOfString:@"/"].location == NSNotFound &&
    ![name isEqualToString:@"."] && ![name isEqualToString:@".."];
  struct stat info;
  bool regular = validName && lstat(executableURL.fileSystemRepresentation, &info) == 0 && S_ISREG(info.st_mode);
  NSString* canonicalBundle = CanonicalPath(bundleURL.fileSystemRepresentation);
  NSString* canonicalExecutable = regular ? CanonicalPath(executableURL.fileSystemRepresentation) : nil;
  NSString* runningExecutable = RunningExecutablePath();
  bool verified = [bundleId isEqualToString:[NSString stringWithUTF8String:kBundleId]] &&
    [bundleURL.pathExtension isEqualToString:@"app"] &&
    [canonicalBundle.pathExtension isEqualToString:@"app"] && regular &&
    canonicalExecutable && runningExecutable &&
    [canonicalExecutable isEqualToString:runningExecutable];
  return @{
    @"bundleIdentifier": bundleId,
    @"bundleURL": canonicalBundle ?: @"",
    @"executableName": name,
    @"executableURL": canonicalExecutable ?: @"",
    @"verified": @(verified),
  };
}

NSDictionary* NotificationCatalog() {
  NSURL* url = [NSBundle.mainBundle URLForResource:@"notify-catalog-v1" withExtension:@"json"];
  if (!url) return nil;
  NSData* data = [NSData dataWithContentsOfURL:url options:0 error:nil];
  if (!data || data.length > 8192) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (!HasExactKeys(parsed, @[@"version", @"title", @"pl", @"en"])) return nil;
  NSDictionary* catalog = parsed;
  if (!IsProtocolVersionOne(catalog[@"version"]) ||
      ![catalog[@"title"] isEqual:@"cashU"]) return nil;
  NSArray<NSString*>* kinds = @[@"signal", @"signalsSummary", @"reviewDigest", @"generic"];
  for (NSString* locale in @[@"pl", @"en"]) {
    NSDictionary* localized = catalog[locale];
    if (!HasExactKeys(localized, kinds)) return nil;
    for (NSString* kind in kinds) {
      NSString* value = localized[kind];
      if (![value isKindOfClass:NSString.class] || value.length == 0 || value.length > 160) return nil;
    }
  }
  return catalog;
}

napi_value String(napi_env env, NSString* value) {
  napi_value result;
  napi_create_string_utf8(env, value.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value Bool(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value ToJsIdentity(napi_env env, napi_callback_info) {
  NSDictionary* identity = BundleIdentity();
  napi_value object;
  napi_create_object(env, &object);
  for (NSString* key in @[@"bundleIdentifier", @"bundleURL", @"executableName", @"executableURL"]) {
    napi_set_named_property(env, object, key.UTF8String, String(env, identity[key]));
  }
  napi_set_named_property(env, object, "verified", Bool(env, [identity[@"verified"] boolValue]));
  return object;
}

bool GetString(napi_env env, napi_value object, const char* name, std::string* out) {
  napi_value value;
  napi_valuetype type;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 256) return false;
  out->resize(length + 1);
  if (napi_get_value_string_utf8(env, value, out->data(), length + 1, &length) != napi_ok) return false;
  out->resize(length);
  return true;
}

bool ExactJsKeys(napi_env env, napi_value object, const char* const* keys, size_t count) {
  napi_value names;
  uint32_t length = 0;
  if (napi_get_property_names(env, object, &names) != napi_ok ||
      napi_get_array_length(env, names, &length) != napi_ok || length != count) return false;
  for (size_t index = 0; index < count; ++index) {
    bool has = false;
    napi_value key;
    napi_create_string_utf8(env, keys[index], NAPI_AUTO_LENGTH, &key);
    if (napi_has_own_property(env, object, key, &has) != napi_ok || !has) return false;
  }
  return true;
}

bool ParseRequest(napi_env env, napi_value value, std::string* requestId,
                  std::string* locale, std::string* kind, std::string* token) {
  const char* keys[] = {"version", "requestId", "locale", "kind", "intentToken"};
  if (!ExactJsKeys(env, value, keys, 5)) return false;
  napi_value version;
  napi_value expected;
  bool equal = false;
  napi_create_int32(env, 1, &expected);
  if (napi_get_named_property(env, value, "version", &version) != napi_ok ||
      napi_strict_equals(env, version, expected, &equal) != napi_ok || !equal ||
      !GetString(env, value, "requestId", requestId) ||
      !GetString(env, value, "locale", locale) ||
      !GetString(env, value, "kind", kind) ||
      !GetString(env, value, "intentToken", token)) return false;
  if (requestId->find('\0') != std::string::npos || token->find('\0') != std::string::npos ||
      locale->find('\0') != std::string::npos || kind->find('\0') != std::string::npos) return false;
  NSString* rid = [NSString stringWithUTF8String:requestId->c_str()];
  NSString* opaque = [NSString stringWithUTF8String:token->c_str()];
  return ValidRequestId(rid) && ValidToken(opaque) &&
    (*locale == "pl" || *locale == "en") &&
    (*kind == "signal" || *kind == "signalsSummary" || *kind == "reviewDigest" || *kind == "generic");
}

@interface AsyncState : NSObject
@property(nonatomic, assign) int status;
@property(nonatomic, strong) dispatch_semaphore_t semaphore;
@end
@implementation AsyncState
@end

enum class Operation { Permission, Post, RequestPermission };
struct Work {
  napi_env env;
  napi_deferred deferred;
  napi_async_work handle;
  Operation operation;
  std::string requestId;
  std::string locale;
  std::string kind;
  std::string token;
  std::string result;
};

void Execute(napi_env, void* data) {
  Work* work = static_cast<Work*>(data);
  @autoreleasepool {
    @try {
      if (![BundleIdentity()[@"verified"] boolValue]) {
        work->result = work->operation == Operation::Post ? "rejected" : "unavailable";
        return;
      }
      UNUserNotificationCenter* center = UNUserNotificationCenter.currentNotificationCenter;
      if (!center) { work->result = work->operation == Operation::Post ? "rejected" : "unavailable"; return; }
      AsyncState* state = [AsyncState new];
      state.semaphore = dispatch_semaphore_create(0);
      if (work->operation == Operation::Permission) {
        state.status = 0;
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
          switch (settings.authorizationStatus) {
            case UNAuthorizationStatusNotDetermined: state.status = 1; break;
            case UNAuthorizationStatusDenied: state.status = 2; break;
            case UNAuthorizationStatusAuthorized:
            case UNAuthorizationStatusProvisional:
              state.status = 3; break;
            default: state.status = 0; break;
          }
          dispatch_semaphore_signal(state.semaphore);
        }];
      } else if (work->operation == Operation::RequestPermission) {
        state.status = 0;
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                              completionHandler:^(BOOL granted, NSError* error) {
          state.status = error ? 0 : (granted ? 3 : 2);
          dispatch_semaphore_signal(state.semaphore);
        }];
      } else {
        NSDictionary* catalog = NotificationCatalog();
        NSString* locale = [NSString stringWithUTF8String:work->locale.c_str()];
        NSString* kind = [NSString stringWithUTF8String:work->kind.c_str()];
        if (!catalog || ![catalog[locale] isKindOfClass:NSDictionary.class] || !catalog[locale][kind]) {
          work->result = "rejected";
          return;
        }
        UNMutableNotificationContent* content = [UNMutableNotificationContent new];
        content.title = catalog[@"title"];
        content.body = catalog[locale][kind];
        content.userInfo = @{
          @"version": @1,
          @"requestId": [NSString stringWithUTF8String:work->requestId.c_str()],
          @"intentToken": [NSString stringWithUTF8String:work->token.c_str()],
        };
        UNNotificationRequest* request = [UNNotificationRequest
          requestWithIdentifier:[NSString stringWithUTF8String:work->requestId.c_str()]
          content:content trigger:nil];
        state.status = 0;
        // From this point any completion error or lost callback is ambiguous. Never report rejected.
        work->result = "unknown";
        [center addNotificationRequest:request withCompletionHandler:^(NSError* error) {
          state.status = error ? 0 : 4;
          dispatch_semaphore_signal(state.semaphore);
        }];
      }
      if (dispatch_semaphore_wait(state.semaphore, dispatch_time(DISPATCH_TIME_NOW, kWaitNanoseconds)) != 0) {
        if (work->operation != Operation::Post) work->result = "unavailable";
        return;
      }
      if (work->operation == Operation::Post) work->result = state.status == 4 ? "accepted" : "unknown";
      else work->result = state.status == 1 ? "pending" :
                          state.status == 2 ? "denied" :
                          state.status == 3 ? "allowed" : "unavailable";
    } @catch (NSException*) {
      if (work->result.empty()) work->result = work->operation == Operation::Post ? "rejected" : "unavailable";
    }
  }
}

void Complete(napi_env env, napi_status, void* data) {
  Work* work = static_cast<Work*>(data);
  napi_value result;
  napi_create_string_utf8(env, work->result.c_str(), NAPI_AUTO_LENGTH, &result);
  napi_resolve_deferred(env, work->deferred, result);
  napi_delete_async_work(env, work->handle);
  delete work;
}

napi_value QueueWork(napi_env env, Work* work) {
  napi_value promise;
  napi_value name;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_string_utf8(env, "cashu-notification", NAPI_AUTO_LENGTH, &name);
  work->env = env;
  if (napi_create_async_work(env, nullptr, name, Execute, Complete, work, &work->handle) != napi_ok ||
      napi_queue_async_work(env, work->handle) != napi_ok) {
    napi_value error;
    napi_create_string_utf8(env, "unavailable", NAPI_AUTO_LENGTH, &error);
    napi_resolve_deferred(env, work->deferred, error);
    if (work->handle) napi_delete_async_work(env, work->handle);
    delete work;
  }
  return promise;
}

napi_value Permission(napi_env env, napi_callback_info) {
  Work* work = new Work{};
  work->operation = Operation::Permission;
  return QueueWork(env, work);
}

napi_value RequestPermission(napi_env env, napi_callback_info) {
  Work* work = new Work{};
  work->operation = Operation::RequestPermission;
  return QueueWork(env, work);
}

napi_value Post(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  Work* work = new Work{};
  work->operation = Operation::Post;
  if (argc != 1 || !ParseRequest(env, argv[0], &work->requestId, &work->locale, &work->kind, &work->token)) {
    work->result = "rejected";
    napi_value promise;
    napi_create_promise(env, &work->deferred, &promise);
    napi_value result;
    napi_create_string_utf8(env, "rejected", NAPI_AUTO_LENGTH, &result);
    napi_resolve_deferred(env, work->deferred, result);
    delete work;
    return promise;
  }
  return QueueWork(env, work);
}

void ScheduleWakeLocked() {
  if (!gHandler || gWakeQueued || gPendingResponses.empty()) return;
  // Exactly one wake is in flight. A full native queue discards its oldest response,
  // never the newest, and this TSFN carries no token-bearing payload of its own.
  if (napi_call_threadsafe_function(gHandler->function, nullptr, napi_tsfn_nonblocking) == napi_ok)
    gWakeQueued = true;
}

void FinalizeHandler(napi_env, void* data, void*) {
  HandlerGeneration* generation = static_cast<HandlerGeneration*>(data);
  {
    std::lock_guard<std::mutex> lock(gHandlerMutex);
    if (gHandler == generation) {
      gHandler = nullptr;
      gWakeQueued = false;
      gPendingResponses.clear();
    }
  }
  delete generation;
}

void DeliverToJs(napi_env env, napi_value callback, void* context, void*) {
  if (!env || !callback) return;
  HandlerGeneration* generation = static_cast<HandlerGeneration*>(context);
  while (true) {
    ResponsePair pair;
    {
      std::lock_guard<std::mutex> lock(gHandlerMutex);
      if (gHandler != generation) return;
      if (gPendingResponses.empty()) {
        gWakeQueued = false;
        return;
      }
      pair = std::move(gPendingResponses.front());
      gPendingResponses.pop_front();
    }
    napi_value object;
    napi_value version;
    napi_value id;
    napi_value token;
    napi_create_object(env, &object);
    napi_create_int32(env, 1, &version);
    napi_create_string_utf8(env, pair.requestId.c_str(), NAPI_AUTO_LENGTH, &id);
    napi_create_string_utf8(env, pair.intentToken.c_str(), NAPI_AUTO_LENGTH, &token);
    napi_set_named_property(env, object, "version", version);
    napi_set_named_property(env, object, "requestId", id);
    napi_set_named_property(env, object, "intentToken", token);
    napi_value global;
    napi_get_global(env, &global);
    if (napi_call_function(env, global, callback, 1, &object, nullptr) != napi_ok) {
      std::lock_guard<std::mutex> lock(gHandlerMutex);
      if (gHandler == generation) {
        gWakeQueued = false;
        ScheduleWakeLocked();
      }
      return;
    }
  }
}

void EnqueueResponse(NSString* requestId, NSString* token) {
  std::lock_guard<std::mutex> lock(gHandlerMutex);
  if (!gHandler) return;
  gPendingResponses.push_back(ResponsePair{requestId.UTF8String, token.UTF8String});
  if (gPendingResponses.size() > kMaxPendingResponses) gPendingResponses.pop_front();
  ScheduleWakeLocked();
}

@interface CashUResponseDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation CashUResponseDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
 didReceiveNotificationResponse:(UNNotificationResponse*)response
         withCompletionHandler:(void (^)(void))completionHandler {
  @try {
    if (![response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) return;
    NSDictionary* info = response.notification.request.content.userInfo;
    if (!HasExactKeys(info, @[@"version", @"requestId", @"intentToken"]) ||
        !IsProtocolVersionOne(info[@"version"]) ||
        !ValidRequestId(info[@"requestId"]) || !ValidToken(info[@"intentToken"]) ||
        ![response.notification.request.identifier isEqualToString:info[@"requestId"]]) return;
    EnqueueResponse(info[@"requestId"], info[@"intentToken"]);
  } @finally { completionHandler(); }
}
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
       willPresentNotification:(UNNotification*)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  // Show the same generic banner while the app is open; no data is added by this delegate.
  completionHandler(UNNotificationPresentationOptionBanner);
}
@end

CashUResponseDelegate* gDelegate = nil; // Strongly held until process exit.

napi_value InstallHandler(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_valuetype type;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function ||
      ![BundleIdentity()[@"verified"] boolValue]) return Bool(env, false);
  napi_value name;
  napi_create_string_utf8(env, "cashu-notification-response", NAPI_AUTO_LENGTH, &name);
  HandlerGeneration* next = new HandlerGeneration{};
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 1, 1, next, FinalizeHandler,
                                      next, DeliverToJs, &next->function) != napi_ok) {
    delete next;
    return Bool(env, false);
  }
  HandlerGeneration* previous;
  {
    std::lock_guard<std::mutex> lock(gHandlerMutex);
    previous = gHandler;
    gHandler = next;
    gWakeQueued = false;
    ScheduleWakeLocked();
    if (!gDelegate) gDelegate = [CashUResponseDelegate new];
    UNUserNotificationCenter.currentNotificationCenter.delegate = gDelegate;
  }
  if (previous) napi_release_threadsafe_function(previous->function, napi_tsfn_release);
  return Bool(env, true);
}

napi_value ReleaseHandler(napi_env env, napi_callback_info) {
  HandlerGeneration* previous;
  {
    std::lock_guard<std::mutex> lock(gHandlerMutex);
    previous = gHandler;
    gHandler = nullptr;
    gWakeQueued = false;
    gPendingResponses.clear();
  }
  if (previous) napi_release_threadsafe_function(previous->function, napi_tsfn_release);
  return Bool(env, true);
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"identity", nullptr, ToJsIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"permissionStatus", nullptr, Permission, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"post", nullptr, Post, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requestPermission", nullptr, RequestPermission, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"installResponseHandler", nullptr, InstallHandler, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseResponseHandler", nullptr, ReleaseHandler, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
