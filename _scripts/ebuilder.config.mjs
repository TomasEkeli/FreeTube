import packageDetails from '../package.json' with { type: 'json' }

/** @type {import('electron-builder').Configuration} */
export default {
  // The fork's own id, not one under upstream's io.freetubeapp domain. On
  // Windows the installer's identity follows it, so Fjernsyn installs beside
  // an official FreeTube, or an earlier build of this fork, and upgrades neither
  appId: 'io.github.tomasekeli.fjernsyn',
  copyright: 'Copyleft © 2020-2026',
  // asar: false,
  // compression: 'store',
  productName: packageDetails.productName,
  directories: {
    output: './build/',
  },
  protocols: [
    {
      name: 'Fjernsyn',
      // freetube:// as well, for the browser redirect extensions; the app
      // releases it again when the handleFreeTubeLinks setting is off
      schemes: [
        'fjernsyn',
        'freetube'
      ]
    }
  ],
  files: [
    '_icons/iconColor.*',
    '_icons/iconTray*.png',
    'icon.svg',
    'dist/**/*',
    '!dist/web/*',
    '!node_modules/**/*',
  ],

  // As we bundle all dependecies with webpack, the `node_modules` folder is excluded from packaging in the `files` array.
  // electron-builder will however still spend time scanning the `node_modules` folder and building up a list of dependencies,
  // returning `false` from the `beforeBuild` hook skips that.
  beforeBuild: () => Promise.resolve(false),
  dmg: {
    contents: [
      {
        path: '/Applications',
        type: 'link',
        x: 410,
        y: 230,
      },
      {
        type: 'file',
        x: 130,
        y: 230,
      },
    ],
    window: {
      height: 380,
      width: 540,
    }
  },
  linux: {
    category: 'AudioVideo;Video;Player;Feed;Network',
    // One image per size, so the sizes of 32 and below get the simpler
    // design drawn for them rather than the full one scaled down
    icon: '_icons/linux',
    // Names the desktop entry and its StartupWMClass after package.json's
    // desktopName, which Electron also takes as the window's app id, so the
    // desktop can tell which entry, and which icon, a running window belongs to
    syncDesktopName: true,
    target: ['deb', 'zip', '7z', 'rpm', 'AppImage', 'pacman'], // 'flatpak'],
  },
  // See the following issues for more information
  // https://github.com/jordansissel/fpm/issues/1503
  // https://github.com/jgraph/drawio-desktop/issues/259
  rpm: {
    fpm: ['--rpm-rpmbuild-define=_build_id_links none']
  },
  deb: {
    depends: [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0'
    ]
  },
  toolsets: {
    appimage: '1.0.3'
  },

  // NOTE: this exists purely for local development builds, we will not provide support for flatpaks built this way!
  // This is here if unofficial builds need to be made
  // The arguments and versions below are examples only and may become outdated
  // The source of truth for the current Flatpak configuration is the Flathub repository
  /*
  flatpak: {
    // install flatpak builder
    // install electron app from flathub. Ex: flatpak install flathub org.electronjs.Electron2.BaseApp/x86_64/25.08
    finishArgs: [
      '--device=dri',
      '--share=ipc',
      '--socket=wayland',
      '--socket=fallback-x11',
      '--socket=pulseaudio',
      '--share=network',
      '--own-name=org.mpris.MediaPlayer2.chromium.*',
      '--own-name=org.mpris.MediaPlayer2.freetube',
      '--talk-name=org.freedesktop.PowerManagement',
      '--talk-name=org.freedesktop.ScreenSaver',
      '--talk-name=org.gnome.SessionManager',
      '--talk-name=org.gnome.SettingsDaemon'
    ],
    runtimeVersion: '25.08',
    baseVersion: '25.08',
  },
  */
  mac: {
    category: 'public.app-category.utilities',
    icon: '_icons/iconMac.icns',
    target: ['dmg', 'zip', '7z'],
    type: 'distribution',
    extendInfo: {
      CFBundleURLTypes: [
        'fjernsyn',
        'freetube'
      ],
      CFBundleURLSchemes: [
        'fjernsyn',
        'freetube'
      ],

      // Clear the default usage descriptions in the Info.plist file set by Electron that we don't need
      // see: https://github.com/electron/electron/blob/main/shell/browser/resources/mac/Info.plist
      NSAudioCaptureUsageDescription: undefined,
      NSBluetoothAlwaysUsageDescription: undefined,
      NSBluetoothPeripheralUsageDescription: undefined,
      NSCameraUsageDescription: undefined,
      NSMicrophoneUsageDescription: undefined,
    },

    // Enable ad-hoc signing
    // If we skip signing entirely, macOS says that the application is damaged, which makes users open bug reports.
    // With an ad-hoc signature it still refuses to launch by default but with the reason that it cannot verify the signature
    identity: '-'
  },
  win: {
    icon: '_icons/icon.ico',
    target: ['nsis', 'zip', '7z', 'portable'],
  },
  nsis: {
    allowToChangeInstallationDirectory: true,
    oneClick: false,
  },
}
