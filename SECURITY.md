# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/elaous/cloudgear/security/advisories/new)
(the repository's Security tab, "Report a vulnerability"). You MUST NOT open a
public issue or pull request for a suspected vulnerability.

Include the affected version or commit, the steps to reproduce, and the impact
you expect. You can expect an acknowledgement, and a fix or a decision, as soon
as the maintainer can manage; this is a small project, so no response time is
guaranteed.

## Scope

In scope: the CLI (`src/`), the runtime packages (`packages/`), the code that
cloudgear bundles into deployed functions, and the IAM policies, function URL
settings and resource policies it generates.

Out of scope: vulnerabilities in third-party dependencies that have no
exploitable path through cloudgear (report them upstream), and misconfiguration
of your own AWS account.

## Supported versions

cloudgear is an early draft. Only the latest commit on `main` receives fixes.
