# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenGem, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **arifozgun41@gmail.com**

Include:
- A description of the vulnerability.
- Steps to reproduce.
- Potential impact.
- Suggested fix (if any).

## Response Timeline

- **Acknowledgment**: Within 48 hours.
- **Initial Assessment**: Within 1 week.
- **Fix & Disclosure**: Coordinated with reporter.

## Scope

The following are in scope:
- Authentication bypass.
- API key leakage or exposure.
- Token encryption weaknesses.
- Unauthorized access to admin dashboard.
- Injection vulnerabilities.

The following are **out of scope**:
- Rate limiting bypass (by design, this is configurable).
- Issues in upstream Google APIs.
- Social engineering attacks.

## Operator Security

- Keep `OPENGEM_HOME`, `.env`, `config.json` and `data/` readable only by the OpenGem service user.
- Configure SMTP in Settings to enable email-based admin 2FA. If SMTP delivery fails, OpenGem does not issue the admin session.
- IP logging for Logs and Requests is disabled by default. Enable it only when your retention policy allows storing client IP addresses.
- Treat CLI access as administrative access. Anyone who can run `opengem` inside the runtime home can manage local accounts, keys and logs.
- The dashboard and CLI update flow uses fixed Git/npm commands. Review local changes before updating from GitHub on production servers.
- Back up `OPENGEM_HOME` before switching database backends or running updates.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | ✅        |
| 0.5.x   | ✅        |

## Acknowledgments

We appreciate responsible disclosure and will credit security researchers (with permission) in our release notes.
