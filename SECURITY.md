# Security Policy

Thank you for helping keep **ping6.it** and its users safe.

## Supported Versions

Security fixes are provided for:
- The `main` branch (latest code)
- The latest deployed production version

Older releases or forks may not receive security updates.

## Reporting a Vulnerability

Please **do not** report security issues via public GitHub issues, discussions, or social media.

Use one of the following private channels:

1. **GitHub Security Advisories (preferred)**
   - Go to the repository page → **Security** → **Report a vulnerability**
   - This creates a private report visible only to maintainers.

2. **Email**
   - Send details to: **antonio@prado.it**
   - Use a clear subject like: `Security: <short description>`

### What to include

To help us triage quickly, include:
- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected URLs/endpoints/components
- Your environment (browser/OS) if relevant
- Any logs, screenshots, or traces (redact sensitive info)
- Suggested mitigation (optional)

If the issue involves **credentials, tokens, or personal data**, please redact them and mention what was removed.

## Scope

This policy covers:
- The ping6.it web application and repository code
- Build/deployment configuration stored in this repository
- Public endpoints operated as part of ping6.it

Out of scope (unless clearly exploitable and impactful):
- Denial of service via high-volume traffic
- Social engineering, phishing, or physical attacks
- Vulnerabilities in third-party services/providers outside our control
- Reports without a working exploit or clear security impact

## Coordinated Disclosure

We follow coordinated disclosure:
- Please give maintainers a chance to investigate and address the issue before public disclosure.
- We may request additional details to reproduce and validate the report.
- Once fixed, we will credit reporters who want attribution (unless you prefer to remain anonymous).

## Safe Harbor

We will not pursue legal action against researchers who:
- Make a good-faith effort to avoid privacy violations and service disruption
- Only access data and systems necessary to demonstrate the vulnerability
- Do not use, modify, or delete data belonging to others
- Report findings privately as described above

