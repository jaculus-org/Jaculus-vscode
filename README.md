# Jaculus - VS Code Extension

Jaculus allows for running JavaScript code on embedded devices.

Visit the project [homepage](https://jaculus.org/getting-started/).


## Features

Currently supports ESP32 and ESP32-S3 SoCs ([Github](https://github.com/jaculus-org/Jaculus-esp32)).


## Requirements

The extension now uses the Jaculus libraries directly instead of wrapping the `jac` CLI.

For end users, that means:
- no separate global `jaculus-tools` installation is required
- project, device, firmware, and WiFi operations run directly inside the extension

For local extension development in this repository, the Jaculus tools monorepo is expected at `../tools` unless the `@jaculus/*` packages and `serialport` are installed as regular dependencies.

## Known Issues

- Jaculus is still in early development and may contain bugs.
- Guide for troubleshooting common problems can be found [here](https://jaculus.org/troubleshooting/).
