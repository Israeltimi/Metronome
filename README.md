# Metronome for Windows 10 Mobile

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20Mobile-0078D7.svg)](https://en.wikipedia.org/wiki/Windows_10_Mobile)
[![Framework](https://img.shields.io/badge/framework-UWP%20(EdgeHTML)-005A9E.svg)](https://learn.microsoft.com/en-us/windows/uwp/)
[![Size](https://img.shields.io/badge/package%20size-223%20KB-success.svg)](#features)
[![License](https://img.shields.io/badge/license-GNU%20GPLv3-blue.svg)](LICENSE)

A modern, high-performance **Material 3 Metronome** app crafted specifically for **Windows 10 Mobile** Lumia smartphones. 

Inspired by and ported from the open-source Android Metronome by [Philipp Bobek](https://github.com/Kr0oked/Metronome), this version delivers the modern Google Material 3 interface, low-latency audio scheduling, background playback, and fluid touch physics to Windows Phone—all packed into an ultra-compact **~223 KB** package.

---

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/Israeltimi/metronome-windows-10-mobile/main/MetronomeUWP/screenshots/main_dark.png" width="30%" alt="Dark Theme" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/Israeltimi/metronome-windows-10-mobile/main/MetronomeUWP/screenshots/main_light.png" width="30%" alt="Light Theme" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/Israeltimi/metronome-windows-10-mobile/main/MetronomeUWP/screenshots/settings.png" width="30%" alt="Settings" />
</p>

---

## Features

- **🎨 1:1 Material Design 3**: Fully tailored layout featuring standard M3 typography, pill-shaped sliders, floating play controls, outlined text fields, and theme tokens.
- **🌓 Dynamic Theming**: Supports **Dark Theme**, **Light Theme**, and **Follow System**, adapting seamlessly to Windows 10 Mobile's accent and dark/light settings.
- **⚡ 60 FPS Hardware-Accelerated Sliders**: Decoupled high-frequency Lumia touch digitizer inputs with `requestAnimationFrame` coalescing. Fast swipes across 30–252 BPM remain completely fluid with zero jitter or main-thread locking.
- **✂️ Zero-Transition Cutout Gaps**: Slider thumb handles feature razor-sharp, zero-gradient 2px surface cutouts in both light and dark modes, perfectly replicating Android Compose's vector track rendering.
- **🎵 Accurate Multi-Voice Audio Engine**:
  - 4 distinct sound sets: **Sine wave**, **Square wave**, **Pluck**, and **Risset drum**.
  - Lookahead Web Audio API scheduling for drift-free tempo accuracy.
  - Option to toggle **Emphasize first beat**.
- **🔴 Adaptive Beat Visualizer & Gap Beats**:
  - Live blinking indicator with automatic diameter scaling (1 to 8 beats) so beat circles never push off-screen.
  - **Gap Beats**: Tap any individual beat circle to mute it—ideal for polyrhythms, syncopation, and internal clock training.
- **⏱️ Tap Tempo & Stepper Controls**:
  - Tap along with the music to quickly find and match any tempo.
  - Incremental stepper buttons with tap (±1 BPM) and long-press (±10 BPM) acceleration.
  - Crash-free outlined number boxes allowing direct keyboard input with auto-formatting.
- **🔕 Background Audio & Silent Toast Notifications**:
  - Keeps playing without interruptions when the screen locks or when multitasking.
  - When minimized, presents a completely silent, non-intrusive notification displaying live BPM and beat status with a one-tap stop action.
- **🔒 50-Year Signing Certificate**:
  - Sideload packages are signed with a permanent root certificate valid through **September 19, 2076**—no need to roll back phone clocks or reinstall certs every year.
- **🪶 Featherweight Footprint**:
  - Entire `.appx` is only **~223 KB**.

---

## Installation on Lumia (Sideloading)

### Prerequisites
On your Windows 10 Mobile phone:
1. Open **Settings** &rarr; **Update & Security** &rarr; **For developers**.
2. Select **Developer mode** (or **Sideload apps**).

---

### Method 1: Direct on Phone (Recommended)
1. Download `Metronome_TestCert.cer` and `Metronome_1.0.0.0_Lumia.appx` from the [Releases](https://github.com/Israeltimi/metronome-windows-10-mobile/releases) page onto your phone (or transfer via USB into the **Downloads** folder).
2. Open the **File Explorer** app on your phone.
3. Tap **`Metronome_TestCert.cer`** and tap **Install Certificate** (select *Root / Trusted People*). *You only need to do this once.*
4. Tap **`Metronome_1.0.0.0_Lumia.appx`** and tap **Install**.
5. The app will install in the background and appear in your All Apps list as **Metronome**.

---

### Method 2: Windows Device Portal (Over Wi-Fi)
1. On your phone, go to **Settings** &rarr; **Update & Security** &rarr; **For developers** and turn on **Device Portal**.
2. Open the URL shown on your phone in your PC's browser (e.g., `http://192.168.1.xxx:80`).
3. Navigate to **Apps** &rarr; **Deploy apps**.
4. Select `Metronome_1.0.0.0_Lumia.appx` and click **Deploy**.

---

### Method 3: Windows 10 SDK (`WinAppDeployCmd`)
```powershell
WinAppDeployCmd.exe install -file "Metronome_1.0.0.0_Lumia.appx" -ip <Phone_IP_Address> -pin <Pin>
```

---

## Building from Source

This repository contains everything needed to build, package, and sign the `.appx` locally without having to install the full 3 GB Windows 10 SDK.

### Build Steps
1. Clone the repository:
   ```bash
   git clone https://github.com/Israeltimi/metronome-windows-10-mobile.git
   cd metronome-windows-10-mobile
   ```
2. Run the automated build script in PowerShell:
   ```powershell
   powershell.exe -ExecutionPolicy Bypass -File .\build.ps1
   ```
3. The signed `.appx` package and public certificate will be generated in `Release/`:
   - `Release/Metronome_1.0.0.0_Lumia.appx`
   - `Release/Metronome_TestCert.cer`

---

## Project Structure

```text
├── MetronomeUWP/            # App source code
│   ├── AppxManifest.xml     # UWP manifest & capabilities
│   ├── index.html           # Main HTML layout
│   ├── app.css              # Material 3 stylesheet & EdgeHTML optimizations
│   ├── app.js               # Audio scheduler, state manager & 60 FPS slider engine
│   ├── assets/              # App icons, splash screens, and tile assets
│   ├── sounds/              # Audio samples (sine, square, pluck, risset drum)
│   └── screenshots/         # Application screenshots
│       ├── main_dark.png
│       ├── main_light.png
│       └── settings.png
├── tools/x64/               # Windows SDK build tools (MakeAppx & SignTool)
├── build.ps1                # Automated packaging and signing script
├── LICENSE                  # GNU General Public License v3.0
└── README.md                # Project documentation
```

---

## Credits & Attribution

- **Port Author & Maintainer**: **Israel Oloruntimilehin** ([@Israeltimi](https://github.com/Israeltimi))
- **Original Android App**: **Philipp Bobek** ([@Kr0oked](https://github.com/Kr0oked/Metronome))

---

## License

This project is licensed under the **GNU General Public License v3.0 (GPLv3)**. See the [LICENSE](LICENSE) file for details.
