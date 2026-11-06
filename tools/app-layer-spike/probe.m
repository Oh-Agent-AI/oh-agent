#import <Cocoa/Cocoa.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>

// Synthetic-only native probe. No authority/log path, token, or user data input.
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *configuration = [[NSBundle mainBundle] pathForResource:@"fixture" ofType:@"json"];
        NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:configuration] options:0 error:NULL];
        if (!fixture) return 2;
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        const char *socketPath = [fixture[@"socket_path"] fileSystemRepresentation];
        if (strlen(socketPath) >= sizeof(address.sun_path)) return 3;
        strlcpy(address.sun_path, socketPath, sizeof(address.sun_path));
        int unixResult = connect(fd, (struct sockaddr *)&address, sizeof(address));
        int unixError = unixResult == 0 ? 0 : errno;
        if (unixResult == 0) {
            struct timeval timeout = {.tv_sec = 10, .tv_usec = 0};
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
            char response;
            if (read(fd, &response, 1) != 1 || response != 'F') {
                close(fd);
                return 4;
            }
        }
        int blockedFile = open([fixture[@"forbidden_path"] fileSystemRepresentation], O_RDONLY);
        int fileError = blockedFile >= 0 ? 0 : errno;
        if (blockedFile >= 0) close(blockedFile);
        int network = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in tcp = {0};
        tcp.sin_family = AF_INET;
        tcp.sin_port = htons([fixture[@"tcp_port"] unsignedShortValue]);
        inet_pton(AF_INET, "127.0.0.1", &tcp.sin_addr);
        int tcpResult = connect(network, (struct sockaddr *)&tcp, sizeof(tcp));
        int tcpError = tcpResult == 0 ? 0 : errno;
        close(network);
        NSString *privatePath = [NSTemporaryDirectory() stringByAppendingPathComponent:@"agent-city-fixture.txt"];
        BOOL ownWrite = [@"fixture only" writeToFile:privatePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        if (ownWrite) [[NSFileManager defaultManager] removeItemAtPath:privatePath error:NULL];
        NSURL *groupURL = fixture[@"app_group"] ? [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:fixture[@"app_group"]] : nil;
        NSDictionary *result = @{@"unix_connected": @(unixResult == 0), @"unix_errno": @(unixError),
            @"forbidden_read": @(blockedFile >= 0), @"file_errno": @(fileError),
            @"tcp_connected": @(tcpResult == 0), @"tcp_errno": @(tcpError),
            @"private_write": @(ownWrite), @"bundle_launched": @YES,
            @"group_path": groupURL ? groupURL.path : @""};
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:NULL];
        if (unixResult == 0) {
            int noSignal = 1;
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
            (void)write(fd, json.bytes, json.length);
        }
        close(fd);
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        fflush(stdout);
    }
    return 0;
}
