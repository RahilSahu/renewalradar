# Security Policy

## Reporting a vulnerability

If you find a security issue in RenewalRadar, please open a GitHub issue with the label "security" and a clear description, or contact the maintainer through their GitHub profile. Please do not include real subscription data, payment details, or anyone's personal information in a report.

## Security model

RenewalRadar is local-first by design:

- All data is stored in the browser's localStorage on the user's own device.
- The app makes no network requests, has no account system, and collects no analytics.
- Export files are generated locally; import files are parsed and strictly validated locally before anything is stored.

The main risks are therefore on the device itself: anyone with access to the browser profile can read the stored data, and clearing site data deletes it. Users tracking sensitive items should export a backup and protect their device and browser profile. RenewalRadar is a tracking aid, not a vault: do not store passwords, card numbers, or other secrets in the notes field.
