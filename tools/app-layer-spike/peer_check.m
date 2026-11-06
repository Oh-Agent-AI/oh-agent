#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <bsm/libbsm.h>
#include <unistd.h>
#include <libproc.h>
#include <sys/proc_info.h>

static BOOL sameBirth(pid_t pid, uint64_t seconds, uint64_t microseconds) {
    struct proc_bsdinfo birth;
    return seconds > 0 && proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &birth, sizeof(birth)) == sizeof(birth)
        && birth.pbi_start_tvsec == seconds && birth.pbi_start_tvusec == microseconds;
}

static NSDictionary *check(int descriptor, pid_t expectedPid, NSString *bundle, NSString *team, NSString *group,
    uint64_t birthSeconds, uint64_t birthMicroseconds, NSString *pinnedHash) {
    uid_t uid; gid_t gid;
    if (getpeereid(descriptor, &uid, &gid) != 0 || uid != getuid())
        return @{@"allowed": @NO, @"reason": @"uid_mismatch"};
    audit_token_t token;
    socklen_t length = sizeof(token);
    if (getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) != 0 || length != sizeof(token))
        return @{@"allowed": @NO, @"reason": @"audit_unavailable"};
    if (expectedPid <= 0 || audit_token_to_pid(token) != expectedPid)
        return @{@"allowed": @NO, @"reason": @"launch_instance_mismatch"};
    if (!sameBirth(expectedPid, birthSeconds, birthMicroseconds))
        return @{@"allowed": @NO, @"reason": @"launch_incarnation_mismatch"};
    SecStaticCodeRef expected = NULL;
    OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:bundle],
        kSecCSDefaultFlags, &expected);
    if (status != errSecSuccess) return @{@"allowed": @NO, @"reason": @"expected_code_unavailable"};
    status = SecStaticCodeCheckValidity(expected, kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode, NULL);
    CFDictionaryRef expectedInfo = NULL;
    if (status == errSecSuccess) status = SecCodeCopySigningInformation((SecCodeRef)expected, kSecCSSigningInformation, &expectedInfo);
    if (status != errSecSuccess) {
        CFRelease(expected);
        return @{@"allowed": @NO, @"reason": @"invalid_expected_signature"};
    }
    NSData *snapshotHash = ((__bridge NSDictionary *)expectedInfo)[(__bridge NSString *)kSecCodeInfoUnique];
    NSMutableString *snapshotHex = [NSMutableString string];
    const unsigned char *bytes = snapshotHash.bytes;
    for (NSUInteger i = 0; i < snapshotHash.length; i++) [snapshotHex appendFormat:@"%02x", bytes[i]];
    if (!snapshotHash || ![snapshotHex isEqualToString:pinnedHash]) {
        CFRelease(expectedInfo);
        CFRelease(expected);
        return @{@"allowed": @NO, @"reason": @"expected_revision_mismatch"};
    }
    NSString *requirementText = [NSString stringWithFormat:
        @"anchor apple generic and identifier \"com.mixlabpro.agent-city-spike.signed\" and certificate leaf[subject.OU] = \"%@\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", team];
    SecRequirementRef requirement = NULL;
    status = SecRequirementCreateWithString((__bridge CFStringRef)requirementText, kSecCSDefaultFlags, &requirement);
    SecCodeRef peer = NULL;
    NSDictionary *attributes = @{(__bridge NSString *)kSecGuestAttributeAudit: [NSData dataWithBytes:&token length:sizeof(token)]};
    if (status == errSecSuccess) status = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &peer);
    if (status == errSecSuccess) status = SecCodeCheckValidity(peer, kSecCSStrictValidate, requirement);
    CFDictionaryRef peerInfo = NULL;
    if (status == errSecSuccess) status = SecCodeCopySigningInformation(peer, kSecCSSigningInformation, &peerInfo);
    NSString *reason = @"dynamic_signature_mismatch";
    BOOL allowed = NO;
    if (status == errSecSuccess) {
        NSDictionary *expectedDictionary = (__bridge NSDictionary *)expectedInfo;
        NSDictionary *peerDictionary = (__bridge NSDictionary *)peerInfo;
        NSData *expectedHash = expectedDictionary[(__bridge NSString *)kSecCodeInfoUnique];
        NSData *peerHash = peerDictionary[(__bridge NSString *)kSecCodeInfoUnique];
        NSDictionary *entitlements = peerDictionary[(__bridge NSString *)kSecCodeInfoEntitlementsDict];
        NSDictionary *minimal = @{@"com.apple.security.app-sandbox": @YES,
            @"com.apple.security.files.user-selected.read-write": @YES,
            @"com.apple.security.application-groups": @[group]};
        BOOL hashMatches = expectedHash && peerHash && [expectedHash isEqualToData:peerHash];
        BOOL profileMatches = [entitlements isEqualToDictionary:minimal];
        BOOL birthMatches = sameBirth(expectedPid, birthSeconds, birthMicroseconds);
        allowed = hashMatches && profileMatches && birthMatches;
        reason = !hashMatches ? @"running_revision_mismatch" : (!profileMatches ? @"sandbox_profile_mismatch"
            : (!birthMatches ? @"launch_incarnation_mismatch" : @"verified"));
    }
    if (peerInfo) CFRelease(peerInfo);
    if (peer) CFRelease(peer);
    if (requirement) CFRelease(requirement);
    CFRelease(expectedInfo);
    CFRelease(expected);
    return @{@"allowed": @(allowed), @"reason": reason};
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 9) return 2;
        NSString *team = [NSString stringWithUTF8String:argv[4]];
        NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[A-Z0-9]{10}$" options:0 error:NULL];
        if (team.length != 10 || [pattern numberOfMatchesInString:team options:0 range:NSMakeRange(0, team.length)] != 1) return 3;
        NSDictionary *result = check(atoi(argv[1]), atoi(argv[2]), [NSString stringWithUTF8String:argv[3]],
            team, [NSString stringWithUTF8String:argv[5]], strtoull(argv[6], NULL, 10), strtoull(argv[7], NULL, 10),
            [NSString stringWithUTF8String:argv[8]]);
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:NULL];
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        // Rejections are test results, not process errors.
        return 0;
    }
}
