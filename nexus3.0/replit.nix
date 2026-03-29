{pkgs}: {
  deps = [
    pkgs.expat
    pkgs.cairo
    pkgs.pango
    pkgs.alsa-lib
    pkgs.mesa
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.libxkbcommon
    pkgs.dbus
    pkgs.libdrm
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
