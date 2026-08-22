# Docker Linux store acceptance boundary

`bun run test:acceptance:linux-store` runs the same adversarial driver on Bun 1.4.0
Debian/glibc and Alpine/musl, using both the container OverlayFS writable layer and a
daemon-created, 16 MiB tmpfs. Image tags and OCI indexes are pinned by digest in the
Dockerfile. Each libc image also initializes a Docker named volume while writable and
remounts that same volume read-only for a prompt, sanitized fail-closed probe that compares
all fixture file hashes and inodes. The driver prints Bun, distribution, libc, filesystem
magic, UID evidence, and a PASS record for every assertion group.

The harness deliberately does not fake evidence that unprivileged Docker cannot provide:

- It cannot validate the host filesystem beneath Docker's OverlayFS. It proves that the
  store runs on OverlayFS; the backing filesystem remains subject to the documented
  deployment contract.
- It does not claim protection against an attacker with UID 10001. Same-UID processes are
  outside the store boundary. The real attacker process uses UID 10002.
- Mount creation is performed by the Docker daemon, not from inside the container. Real
  ENOSPC is induced only on the bounded tmpfs; the OverlayFS runs explicitly report that
  scenario as not applicable.
- The actual character-device rejection fixture requires Docker's `CAP_MKNOD` and is
  mandatory in both OverlayFS cells. A missing capability fails the cell explicitly.
  The nodev tmpfs cells report that fixture as not applicable; all other malicious object
  fixtures remain mandatory there.

The process must start as container root so the orchestrator can stage foreign-owned and
special filesystem objects and then launch the actual store processes as UID/GID 10001.
No network is available, every wait has a deadline, and Docker `--rm --init` plus shell
traps/timeouts provide cleanup.
