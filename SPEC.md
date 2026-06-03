# Claude Hub - Specifications & Test Requirements

## Goal
Centralized launcher and provider manager for Claude Code.

## Requirements
- [ ] **Parity**: Core functionality must mirror the opencode-hub exactly.
- [ ] **Provider Tab**: Includes an extra tab in the 'Plugins' section specifically for selecting providers.
- [ ] **Custom Auth Login**: Features a custom 'cc auth login' interface that replicates the 'oc auth login' experience, allowing users to add accounts.
- [ ] **No Default Provider**: Must NOT have a preinstalled default provider.
- [ ] **Empty State Fallback**: If zero providers are detected (in the Provider tab or cc auth login), it MUST show a prompt allowing the user to install the claude-code-auth plugin in one click.
