#include <arpa/inet.h>
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#else
#error "The Cursor SDK loopback fixture needs native ARM64 or x86-64 Linux"
#endif

#define LOAD(member) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, member))
#define EQ(value, yes, no) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, value, yes, no)
#define RETURN(action) BPF_STMT(BPF_RET | BPF_K, action)
#define DENY RETURN(SECCOMP_RET_ERRNO | EAFNOSUPPORT)

static int landlock_abi(void) {
  return (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
}

// Restrict TCP connects to the kernel's ephemeral port range, which is where
// the loopback backend and daemon bind with port 0. The Cursor API on 443 and
// every other well-known port become unreachable without privileges.
static int restrict_tcp_connect(void) {
  int abi = landlock_abi();
  if (abi < 4) {
    fprintf(stderr, "Cursor fixture needs Landlock ABI 4 for TCP rules; found %d\n", abi);
    return -1;
  }
  unsigned low, high;
  FILE *range = fopen("/proc/sys/net/ipv4/ip_local_port_range", "r");
  if (!range) return -1;
  int fields = fscanf(range, "%u %u", &low, &high);
  fclose(range);
  if (fields != 2 || low < 1024 || high > 65535 || low > high) {
    fputs("Cursor fixture rejected the ephemeral port range\n", stderr);
    return -1;
  }
  struct landlock_ruleset_attr attr = {.handled_access_net = LANDLOCK_ACCESS_NET_CONNECT_TCP};
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) return -1;
  for (unsigned port = low; port <= high; port++) {
    struct landlock_net_port_attr rule = {
      .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
      .port = port,
    };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_NET_PORT, &rule, 0) < 0) {
      close(ruleset);
      return -1;
    }
  }
  int restricted = prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0
                       ? -1
                       : (int)syscall(SYS_landlock_restrict_self, ruleset, 0);
  close(ruleset);
  return restricted;
}

static int restrict_sockets(void) {
  // A pathname or abstract UNIX socket can reach a host proxy that the Landlock TCP rules miss.
  // Keep only the connected stream pairs Node needs for child-process IPC.
  struct sock_filter instructions[] = {
    LOAD(arch),
    EQ(NATIVE_ARCH, 1, 0),
    RETURN(SECCOMP_RET_KILL_PROCESS),
    LOAD(nr),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    RETURN(SECCOMP_RET_KILL_PROCESS),
#endif
    EQ(SYS_io_uring_setup, 0, 1),
    DENY,
    EQ(SYS_socket, 0, 6),
    LOAD(args[0]),
    EQ(AF_INET, 3, 0),
    EQ(AF_INET6, 2, 0),
    EQ(AF_NETLINK, 1, 0),
    DENY,
    RETURN(SECCOMP_RET_ALLOW),
    EQ(SYS_socketpair, 0, 7),
    LOAD(args[0]),
    EQ(AF_UNIX, 1, 0),
    DENY,
    LOAD(args[1]),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK)),
    EQ(SOCK_STREAM, 1, 0),
    DENY,
    RETURN(SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = sizeof(instructions) / sizeof(instructions[0]),
    .filter = instructions,
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

static int preflight(void) {
  int pair[2];
  if (socket(AF_UNIX, SOCK_STREAM, 0) != -1 || errno != EAFNOSUPPORT) return 1;
  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) != -1 || errno != EAFNOSUPPORT) return 1;
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0) return 1;
  close(pair[0]);
  close(pair[1]);

  // TEST-NET-1 is reserved for documentation; 443 is the Cursor API's port.
  struct sockaddr_in destination = {.sin_family = AF_INET, .sin_port = htons(443)};
  if (inet_pton(AF_INET, "192.0.2.1", &destination.sin_addr) != 1) return 1;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 1;
  int blocked = connect(fd, (struct sockaddr *)&destination, sizeof(destination)) == -1 &&
                errno == EACCES;
  close(fd);
  return !blocked;
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (restrict_tcp_connect() < 0) {
    perror("Cursor fixture Landlock");
    return 1;
  }
  if (restrict_sockets() < 0) {
    perror("Cursor fixture seccomp");
    return 1;
  }
  if (strcmp(argv[1], "--preflight") == 0) {
    if (preflight() == 0) return 0;
    fputs("Cursor fixture native egress preflight failed\n", stderr);
    return 1;
  }
  execvp(argv[1], argv + 1);
  perror("Cursor fixture exec");
  return 1;
}
