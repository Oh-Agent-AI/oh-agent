#import <Cocoa/Cocoa.h>
#include <libproc.h>
#include <sys/proc_info.h>

// Host-side LaunchServices adapter. Never exec the application binary.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "--birth") == 0) {
            struct proc_bsdinfo birth;
            if (proc_pidinfo(atoi(argv[2]), PROC_PIDTBSDINFO, 0, &birth, sizeof(birth)) != sizeof(birth)) return 5;
            NSDictionary *snapshot = @{@"birth_seconds": @(birth.pbi_start_tvsec), @"birth_microseconds": @(birth.pbi_start_tvusec)};
            NSData *json = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:NULL];
            fwrite(json.bytes, 1, json.length, stdout);
            return 0;
        }
        if (argc != 2) return 2;
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES];
        NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
        configuration.createsNewApplicationInstance = YES;
        configuration.allowsRunningApplicationSubstitution = NO;
        configuration.activates = NO;
        configuration.addsToRecentItems = NO;
        configuration.promptsUserIfNeeded = NO;
        configuration.arguments = @[];
        configuration.environment = @{};
        __block BOOL finished = NO;
        __block NSDictionary *result = nil;
        [[NSWorkspace sharedWorkspace] openApplicationAtURL:url configuration:configuration
            completionHandler:^(NSRunningApplication *application, NSError *error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    BOOL exact = application && [application.bundleURL.URLByResolvingSymlinksInPath.path
                        isEqualToString:url.URLByResolvingSymlinksInPath.path];
                    struct proc_bsdinfo birth = {0};
                    BOOL alive = application && !application.terminated && proc_pidinfo(application.processIdentifier,
                        PROC_PIDTBSDINFO, 0, &birth, sizeof(birth)) == sizeof(birth) && !application.terminated;
                    result = @{@"pid": application ? @(application.processIdentifier) : @0,
                        @"birth_seconds": @(birth.pbi_start_tvsec), @"birth_microseconds": @(birth.pbi_start_tvusec),
                        @"exact_bundle": @(exact), @"launched": @(!error && exact && alive)};
                    finished = YES;
                });
            }];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
        while (!finished && deadline.timeIntervalSinceNow > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        if (!finished) return 3;
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:NULL];
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        return [result[@"launched"] boolValue] ? 0 : 4;
    }
}
