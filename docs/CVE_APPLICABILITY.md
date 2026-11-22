# Residual container CVE applicability (final audit M04)

Image: `frontdesk-app:rc-7b02b7ba251a-amd64 (source 7b02b7ba251a772ca759c7f5083f07a88fb57cbf)` — config digest `sha256:fd86f045c0311e0d31655e106aaed7db57ca206849dc88bf60bc9ac7c6098cd5`, platform linux/amd64.
Trivy 0.76.2 scan of that exact image; vulnerability DB updated 2026-11-21 18:38 UTC (Trivy 0.76.2, DB schema v2).
HIGH/CRITICAL: 38 package findings (1 CRITICAL, 37 HIGH) across 11 distinct advisories; **fixable: 0**; application (npm) findings: 0.
Lower severities, summarised (full detail in the retained JSON report): 95 LOW, 108 MEDIUM, 10 UNKNOWN. Fixable count above covers ALL severities.

`--ignore-unfixed` in the CI gate only means "no fix is published yet"; it does NOT mean these vulnerabilities are absent. Every row below remains open in the risk register.
The decisions are **proposed** by engineering for the owner; they are not accepted on the owner's behalf.

## Per-advisory analysis

### CVE-2023-45853 — CRITICAL — upstream status: will_not_fix
Packages: `zlib1g 1:1.2.13.dfsg-1`
Title: zlib: integer overflow and resultant heap-based buffer overflow in zipOpenNewFileInZip4_6
- Reachable functionality: MiniZip (contrib/minizip) zipOpenNewFileInZip4_64 integer overflow. Debian marks it will_not_fix because the zlib1g binary package does not ship MiniZip. Frontdesk never creates ZIP archives.
- Mitigations: Not present in the shipped library; Node.js uses its own bundled zlib (see linkage).
- Residual uncertainty: None identified for this image.
- Proposed decision: Not applicable (proposed).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2025-6020 — HIGH — upstream status: affected
Packages: `libpam-modules 1.5.2-6+deb12u2`, `libpam-modules-bin 1.5.2-6+deb12u2`, `libpam-runtime 1.5.2-6+deb12u2`, `libpam0g 1.5.2-6+deb12u2`
Title: linux-pam: Linux-pam directory Traversal
- Reachable functionality: linux-pam pam_namespace directory traversal during PAM authentication (login/su/sshd style services).
- Mitigations: No PAM-using service runs in the container (no login, su, sshd, cron); the app authenticates users in-process (Argon2id); no-new-privileges blocks setuid escalation.
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2025-69720 — HIGH — upstream status: affected
Packages: `libtinfo6 6.4-4`, `ncurses-base 6.4-4`, `ncurses-bin 6.4-4`
Title: ncurses: ncurses: Buffer overflow vulnerability may lead to arbitrary code execution.
- Reachable functionality: ncurses buffer overflow when processing crafted terminfo data (terminal programs).
- Mitigations: The process has no TTY and executes no terminal programs (CMD is node directly; the healthcheck is node).
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-16742 — HIGH — upstream status: fix_deferred
Packages: `libsystemd0 252.39-1~deb12u2`, `libudev1 252.39-1~deb12u2`
Title: systemd: systemd-homed: Local privilege escalation via missing home-record signature verification
- Reachable functionality: systemd-homed local privilege escalation. libsystemd0/libudev1 are shared libraries only; systemd-homed is not installed and no systemd runs in the container.
- Mitigations: No init system or homed daemon; tini/docker-init is PID 1; non-root, no-new-privileges.
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-41992 — HIGH — upstream status: fix_deferred
Packages: `gzip 1.12-1`
Title: gzip: gzip: Information disclosure via global buffer overflow in LZH decompression
- Reachable functionality: gzip(1) LZH decoding buffer overflow when decompressing a crafted file with the gzip binary.
- Mitigations: The gzip binary is never executed by the application.
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-53613 — HIGH — upstream status: affected
Packages: `bsdutils 1:2.38.1-5+deb12u3`, `libblkid1 2.38.1-5+deb12u3`, `libmount1 2.38.1-5+deb12u3`, `libsmartcols1 2.38.1-5+deb12u3`, `libuuid1 2.38.1-5+deb12u3`, `mount 2.38.1-5+deb12u3`, `util-linux 2.38.1-5+deb12u3`, `util-linux-extra 2.38.1-5+deb12u3`
Title: util-linux: TOCTOU in the mount program via ancestor directory swap on target path
- Reachable functionality: util-linux mount(8) TOCTOU during mount. Requires executing mount with mount privileges.
- Mitigations: The app never executes mount; container runs non-root with cap_drop ALL and no-new-privileges, so mounting is impossible.
- Residual uncertainty: Libraries (libmount, libblkid, libuuid, libsmartcols) are present but not linked by the application runtime (see linkage).
- Proposed decision: Not exploitable in this deployment (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-53615 — HIGH — upstream status: affected
Packages: `bsdutils 1:2.38.1-5+deb12u3`, `libblkid1 2.38.1-5+deb12u3`, `libmount1 2.38.1-5+deb12u3`, `libsmartcols1 2.38.1-5+deb12u3`, `libuuid1 2.38.1-5+deb12u3`, `mount 2.38.1-5+deb12u3`, `util-linux 2.38.1-5+deb12u3`, `util-linux-extra 2.38.1-5+deb12u3`
Title: util-linux: util-linux: Partition metadata compromise via integer overflow in DOS partition parser
- Reachable functionality: util-linux partition-table parsing (libblkid/libfdisk) integer overflow on crafted partition metadata. Requires probing an attacker-supplied block device or image.
- Mitigations: No block-device or image probing occurs; no util-linux binaries are executed; no device access in the container.
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-54369 — HIGH — upstream status: fix_deferred
Packages: `libacl1 2.3.1-3`
Title: acl: Symlink traversal privilege escalation via libacl functions
- Reachable functionality: libacl symlink traversal in ACL helper functions used by tools such as cp/setfacl under privilege.
- Mitigations: No ACL tools are executed; read-only rootfs; non-root process.
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-78410 — HIGH — upstream status: affected
Packages: `bsdutils 1:2.38.1-5+deb12u3`, `libblkid1 2.38.1-5+deb12u3`, `libmount1 2.38.1-5+deb12u3`, `libsmartcols1 2.38.1-5+deb12u3`, `libuuid1 2.38.1-5+deb12u3`, `mount 2.38.1-5+deb12u3`, `util-linux 2.38.1-5+deb12u3`, `util-linux-extra 2.38.1-5+deb12u3`
Title: util-linux: util-linux: restricted bind mounts do not pin the source, allowing X-mount.owner/group/mode redirection
- Reachable functionality: util-linux restricted bind mounts do not pin the source. Requires performing bind mounts.
- Mitigations: Mounting is impossible for the non-root, capability-less container process.
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-85091 — HIGH — upstream status: affected
Packages: `zlib1g 1:1.2.13.dfsg-1`
Title: zlib: zlib: Heap buffer overflow in gz_vacate() allows arbitrary code execution
- Reachable functionality: zlib gz_vacate() (gzip FILE API: gzopen/gzwrite/gzclose). Only reachable by a process that links the SYSTEM libz.so.1 and uses the gz* file API on attacker-influenced data.
- Mitigations: See linkage evidence: the Node.js runtime compresses with its statically bundled zlib; the app never calls the gz* file API; no shell or archive tools are executed; non-root, read-only rootfs, all capabilities dropped.
- Residual uncertainty: If a linked native module used system zlib gz* functions it would be exposed; linkage evidence lists every object linking libz.
- Proposed decision: Accept until Debian ships a fix (proposed); weekly rebuild picks it up automatically.
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

### CVE-2026-9538 — HIGH — upstream status: fix_deferred
Packages: `perl-base 5.36.0-7+deb12u4`
Title: perl-Archive-Tar: perl-Archive-Tar: Denial of Service via crafted tar header with large entry size
- Reachable functionality: perl Archive::Tar denial of service on crafted tar input.
- Mitigations: Perl is not executed at runtime (perl-base is a dpkg dependency); the app processes no tar files.
- Residual uncertainty: Low.
- Proposed decision: Not reachable (proposed accept).
- Review date: 2026-11-22; next review: weekly security run or when a fix is published.

## Linkage evidence (from the same image)

```
node binary links: libdl.so.2 libstdc++.so.6 libm.so.6 libgcc_s.so.1 libpthread.so.0 libc.so.6 /lib64/ld-linux-x86-64.so.2 
libz.so linked by app/node objects: none
libsystemd.so linked by app/node objects: none
libudev.so linked by app/node objects: none
libtinfo.so linked by app/node objects: none
libacl.so linked by app/node objects: none
libpam.so linked by app/node objects: none
libblkid.so linked by app/node objects: none
libmount.so linked by app/node objects: none
libuuid.so linked by app/node objects: none
libsmartcols.so linked by app/node objects: none
```
