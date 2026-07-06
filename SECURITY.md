# Security Policy

## Supported Versions

ccmux ships as a single rolling release. Only the latest published version on the [releases page](https://github.com/epilande/ccmux/releases) receives security fixes. If you are on an older version, please upgrade before reporting.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Report vulnerabilities privately through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/epilande/ccmux/security) of the repository.
2. Click **Report a vulnerability** (or use [this direct link](https://github.com/epilande/ccmux/security/advisories/new)).
3. Fill in the advisory with as much detail as you can.

If the advisory form is unavailable for any reason, email [epilande@gmail.com](mailto:epilande@gmail.com) instead.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- The affected `ccmux --version`, your OS, and your tmux version (`tmux -V`).
- Any relevant configuration (installed hooks, custom agents, non-default config).

## What to Expect

- We aim to acknowledge new reports within a few days.
- We will keep you updated on our progress as we investigate and work on a fix.
- Once a fix is released, we are happy to credit you in the advisory unless you prefer to remain anonymous.

Thank you for helping keep ccmux and its users safe.
