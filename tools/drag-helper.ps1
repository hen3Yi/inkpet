# InkPet drag helper -- native window follower (no app-region, so right-click stays alive)
# Protocol on stdin, one command per line:
#   DRAGSTART <hwnd>          start following the cursor (8ms loop, SetWindowPos with SWP_NOSIZE)
#   BOUNDS <l> <t> <r> <b>    MODEL bounding box inside the window (PHYSICAL px, relative to window top-left).
#                             When set, the MODEL (not the whole window) is clamped inside the monitor
#                             work area -- same idea as Petra's screen.rs drag_follow, so the character
#                             itself never leaves the screen (the transparent margin may).
#                             Work area is picked by the monitor under the window center (multi-display safe).
#   RECT <hwnd>               print window rect + work area, for diagnostics
#   TARGET <hwnd>             window the AUTO fallback watches (see AUTO note below)
#   HITBOX <l> <t> <r> <b>    model box in PHYSICAL px, window-relative; silent (no echo)
#   MASK <cell> <cols> <rows> <base64>
#                             hit outline (2026-10-17): bit i = cy * cols + cx (LSB first) is set when the
#                             <cell>-px (PHYSICAL, may be fractional) square cx, cy of the window shows the
#                             character. When set, the AUTO fallback hit-tests against it instead of HITBOX,
#                             so the transparent parts of the window do not grab presses. Silent.
#   FIT <hwnd> <l> <t> <r> <b>
#                             move the window once so the box (window-relative, PHYSICAL px) is inside the
#                             work area -- same clamp as dragging; echoes only when it moved
#   FITCALC <wl> <wt> <l> <t> <r> <b> <al> <at> <ar> <ab>
#                             diagnostics: where the clamp would put a window at wl,wt for that box and work area
#   TESTHIT <rx> <ry>         diagnostics: hit test a window-relative point (PHYSICAL px), echoes 1 / 0
#   AUTO 0|1                  enable/disable the AUTO fallback state machine
#   DRAGEND                   stop following
#   QUIT                      exit
#   AUTO mode emits: EVT DRAGSTART / EVT DRAGEND / EVT CLICK / EVT RCLICK (physical px)
#                    EVT CLICK <x> <y> <holdMs>: emitted on release; holdMs = how long the button was down,
#                    so the main process can tell which press it was (did the renderer already get it?)
#
# UNIT CONTRACT (2026-09-20): this process forces DPI awareness at startup, so EVERY coordinate it
#   sees or writes -- GetWindowRect, GetCursorPos, SetWindowPos, the GetMonitorInfo work area, and
#   the BOUNDS line coming from Electron -- is PHYSICAL px, one single ruler.
#   Why it matters: a DPI-unaware PowerShell reports virtualized coordinates (window read as
#   1447,688 232x276 while the work area was 2560x1392 physical), so adding a physical BOUNDS box to
#   a virtualized window position made the right/bottom clamp unreachable -- the pet could still be
#   dragged off screen.
#
# Note: keep this file ASCII-only -- Windows PowerShell 5.1 reads .ps1 as ANSI.
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class InkPetFollower {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsProcessDPIAware();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOZORDER = 0x0004;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

  static Thread worker;
  static volatile bool running;
  static IntPtr hwnd = IntPtr.Zero;
  static int offX, offY;

  // Model bounding box inside the window (physical px, relative to window top-left).
  static int bL = 0, bT = 0, bR = 0, bB = 0;
  static bool hasBounds = false;

  public static void SetBounds(int l, int t, int r, int b) {
    bL = l; bT = t; bR = r; bB = b;
    hasBounds = (r > l && b > t);
  }

  // Where the window has to go so the box (window-relative) stays inside the work area.
  static void ClampInto(ref int nx, ref int ny, int l, int t, int r, int b, RECT area) {
    if (nx + l < area.L) nx = area.L - l;
    if (nx + r > area.R) nx = area.R - r;
    if (ny + t < area.T) ny = area.T - t;
    if (ny + b > area.B) ny = area.B - b;
  }

  // One-off clamp (after a character switch / resize): move only if the box sticks out.
  // Returns null when nothing moved.
  public static string Fit(long handle, int l, int t, int r, int b) {
    if (running) return null;   // being dragged: the drag loop clamps
    IntPtr h = new IntPtr(handle);
    RECT wr;
    if (r <= l || b <= t || !GetWindowRect(h, out wr)) return null;
    int nx = wr.L, ny = wr.T;
    ClampInto(ref nx, ref ny, l, t, r, b, WorkAreaAt(wr.L + (l + r) / 2, wr.T + (t + b) / 2));
    if (nx == wr.L && ny == wr.T) return null;
    SetWindowPos(h, IntPtr.Zero, nx, ny, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    return wr.L + "," + wr.T + " -> " + nx + "," + ny;
  }

  public static string FitCalc(int wl, int wt, int l, int t, int r, int b, int aL, int aT, int aR, int aB) {
    RECT a; a.L = aL; a.T = aT; a.R = aR; a.B = aB;
    int nx = wl, ny = wt;
    ClampInto(ref nx, ref ny, l, t, r, b, a);
    return nx + "," + ny;
  }

  static RECT WorkAreaAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr mon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (GetMonitorInfo(mon, ref mi)) return mi.rcWork;
    RECT d; d.L = 0; d.T = 0; d.R = 1920; d.B = 1080; return d;
  }

  // Diagnostics: prove which coordinate space is in effect (physical px expected).
  public static string DpiState() { return "aware=" + IsProcessDPIAware(); }

  public static string RectReport(long handle) {
    RECT r;
    if (!GetWindowRect(new IntPtr(handle), out r)) return "rect=none";
    RECT a = WorkAreaAt(r.L + (r.R - r.L) / 2, r.T + (r.B - r.T) / 2);
    return "rect=" + r.L + "," + r.T + "," + r.R + "," + r.B
      + " size=" + (r.R - r.L) + "x" + (r.B - r.T)
      + " work=" + a.L + "," + a.T + "," + a.R + "," + a.B;
  }

  public static bool Start(long handle) {
    IntPtr h = new IntPtr(handle);
    // Already following this window (external DRAGSTART or the AUTO state machine):
    // restarting would re-derive the grab offset from the current cursor and jump.
    if (running && hwnd == h) { Say("EVT START_ALREADY h=" + handle); return true; }
    Stop();
    POINT p;
    RECT r;
    if (!GetCursorPos(out p)) { Say("EVT START_FAIL cursor"); return false; }
    if (!GetWindowRect(h, out r)) { Say("EVT START_FAIL rect h=" + handle); return false; }
    hwnd = h;
    offX = p.X - r.L;
    offY = p.Y - r.T;
    running = true;
    worker = new Thread(Loop);
    worker.IsBackground = true;
    worker.Start();
    Say("EVT START_OK off=" + offX + "," + offY + " cur=" + p.X + "," + p.Y + " win=" + r.L + "," + r.T);
    return true;
  }

  // AUTO drag: derive the grab offset from the button-down point, not from the current
  // cursor -- by the time MOVE_THRESHOLD is exceeded the cursor has already travelled.
  public static bool StartAt(IntPtr h, int x, int y) {
    if (running && hwnd == h) { Say("EVT STARTAT_ALREADY"); return true; }
    Stop();
    RECT r;
    if (!GetWindowRect(h, out r)) { Say("EVT STARTAT_FAIL rect"); return false; }
    hwnd = h;
    offX = x - r.L;
    offY = y - r.T;
    running = true;
    worker = new Thread(Loop);
    worker.IsBackground = true;
    worker.Start();
    Say("EVT STARTAT_OK off=" + offX + "," + offY + " at=" + x + "," + y + " win=" + r.L + "," + r.T);
    return true;
  }

  public static void Stop() {
    running = false;
    Thread t = worker;
    worker = null;
    if (t != null) { try { t.Join(200); } catch { } }
    Say("EVT STOP");
  }

  // ---------------------------------------------------------------------------
  // AUTO fallback (2026-09-21). Symptom: after the display sleeps, Windows stops
  // delivering WM_LBUTTONDOWN to this never-activated (WS_EX_NOACTIVATE) window while
  // mouse MOVES still arrive -- clicking and dragging the pet both die, every other
  // window stays fine. Sampling proved the EX bits, the hit test, the capture ownership
  // and the press timing were all correct and the renderer still saw zero MDOWN; an
  // injected WM_LBUTTONDOWN worked instantly, so only the system delivery step is broken.
  // Fix: take the renderer out of the loop. This thread polls the button state itself and
  // drives the native follower directly, so dragging / clicking / the context menu no
  // longer depend on the window receiving any mouse message.
  // ---------------------------------------------------------------------------
  static volatile bool autoOn = false;
  static Thread autoThread;
  static IntPtr targetHwnd = IntPtr.Zero;
  static int hbL = 0, hbT = 0, hbR = 0, hbB = 0;
  static bool hasHit = false;
  const int HIT_PAD = 15;        // physical px == the main process HIT_PAD (10 css * 1.5)
  const int MOVE_THRESHOLD = 5;  // physical px of travel before a press counts as a drag
  static readonly object outLock = new object();

  public static void Say(string s) {
    lock (outLock) {
      try { Console.Out.WriteLine(s); Console.Out.Flush(); } catch { }
    }
  }

  public static void SetTarget(long h) { targetHwnd = new IntPtr(h); }

  public static void SetHitbox(int l, int t, int r, int b) {
    hbL = l; hbT = t; hbR = r; hbB = b;
    hasHit = (r > l && b > t);
  }

  // Hit outline: one immutable object swapped in whole, so the AUTO thread never sees a half-updated mask.
  class HitMask { public double Cell; public int Cols; public int Rows; public byte[] Bits; }
  static volatile HitMask hitMask = null;

  public static bool SetMask(double cell, int cols, int rows, string b64) {
    try {
      byte[] b = Convert.FromBase64String(b64);
      if (cell > 0 && cols > 0 && rows > 0 && (long)b.Length * 8 >= (long)cols * rows) {
        HitMask m = new HitMask();
        m.Cell = cell; m.Cols = cols; m.Rows = rows; m.Bits = b;
        hitMask = m;
        return true;
      }
    } catch { }
    return false;
  }

  // rx, ry: PHYSICAL px relative to the window's top-left
  static bool HitAt(int rx, int ry) {
    HitMask m = hitMask;
    if (m != null) {
      int cx = (int)Math.Floor(rx / m.Cell), cy = (int)Math.Floor(ry / m.Cell);
      if (cx < 0 || cy < 0 || cx >= m.Cols || cy >= m.Rows) return false;
      int i = cy * m.Cols + cx;
      return (m.Bits[i >> 3] & (1 << (i & 7))) != 0;
    }
    if (!hasHit) return false;
    return rx >= hbL - HIT_PAD && rx <= hbR + HIT_PAD && ry >= hbT - HIT_PAD && ry <= hbB + HIT_PAD;
  }

  public static string TestHit(int rx, int ry) { return HitAt(rx, ry) ? "1" : "0"; }

  public static void SetAuto(bool on) {
    autoOn = on;
    if (on && autoThread == null) {
      autoThread = new Thread(AutoLoop);
      autoThread.IsBackground = true;
      autoThread.Start();
    }
  }

  static bool InHit(int x, int y) {
    if (targetHwnd == IntPtr.Zero) return false;
    RECT w;
    if (!GetWindowRect(targetHwnd, out w)) return false;
    return HitAt(x - w.L, y - w.T);
  }

  static void AutoLoop() {
    bool prevL = false, prevR = false;
    int px = 0, py = 0, downTick = 0;
    bool inside = false, moved = false, autoDrag = false;
    int tick = 0;
    Say("EVT AUTO_LOOP_ENTER");
    while (true) {
      Thread.Sleep(8);
      tick++;
      if (!autoOn || targetHwnd == IntPtr.Zero) {
        if (autoDrag) { Stop(); autoDrag = false; Say("EVT DRAGEND " + px + " " + py); }
        prevL = false; prevR = false;
        continue;
      }
      bool l = (GetAsyncKeyState(0x01) & 0x8000) != 0;
      bool r = (GetAsyncKeyState(0x02) & 0x8000) != 0;
      POINT p;
      if (!GetCursorPos(out p)) { prevL = l; prevR = r; continue; }
      if (l && !prevL) { px = p.X; py = p.Y; moved = false; inside = InHit(px, py); downTick = Environment.TickCount; }
      if (l) {
        if (!moved && (Math.Abs(p.X - px) > MOVE_THRESHOLD || Math.Abs(p.Y - py) > MOVE_THRESHOLD)) moved = true;
        if (inside && moved && !autoDrag) {
          if (hasHit) SetBounds(hbL, hbT, hbR, hbB);   // clamp to the character's current box while dragging
          if (StartAt(targetHwnd, px, py)) {
            autoDrag = true;
            Say("EVT DRAGSTART " + px + " " + py);
          }
        }
      }
      if (!l && prevL) {
        if (autoDrag) {
          Stop(); autoDrag = false;
          Say("EVT DRAGEND " + p.X + " " + p.Y);
        } else if (inside && !moved) {
          Say("EVT CLICK " + px + " " + py + " " + Math.Max(0, Environment.TickCount - downTick));
        }
      }
      if (r && !prevR) {
        if (InHit(p.X, p.Y)) Say("EVT RCLICK " + p.X + " " + p.Y);
      }
      // low-rate heartbeat (~30s): proves the fallback thread is alive and still sees the hit box
      if (tick % 3750 == 0) {
        Say("EVT AUTO_TICK l=" + (l ? 1 : 0) + " r=" + (r ? 1 : 0) + " in=" + (InHit(p.X, p.Y) ? 1 : 0) +
            " hit=" + (hasHit ? 1 : 0) + " tgt=" + targetHwnd.ToInt64() + " cur=" + p.X + "," + p.Y);
      }
      prevL = l; prevR = r;
    }
  }

  static void Loop() {
    Say("EVT LOOP_ENTER h=" + hwnd.ToInt64());
    while (running) {
      POINT p;
      if (GetCursorPos(out p)) {
        int nx = p.X - offX;
        int ny = p.Y - offY;
        // Clamp the MODEL box inside the work area of the monitor under the box center.
        if (hasBounds) {
          ClampInto(ref nx, ref ny, bL, bT, bR, bB, WorkAreaAt(nx + (bL + bR) / 2, ny + (bT + bB) / 2));
        }
        // SWP_NOSIZE keeps the window size fixed -> no more "window grows while dragging"
        SetWindowPos(hwnd, IntPtr.Zero, nx, ny, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
      }
      Thread.Sleep(8);
    }
    Say("EVT LOOP_EXIT");
  }
}
"@

# Force DPI awareness BEFORE any cursor/window API is touched, so this process and Electron share
# one physical-px ruler (see UNIT CONTRACT above).
[void][InkPetFollower]::SetProcessDPIAware()
[InkPetFollower]::Say("OK READY " + [InkPetFollower]::DpiState())

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -match '^DRAGSTART\s+(\d+)$') {
    $ok = [InkPetFollower]::Start([int64]$Matches[1])
    [InkPetFollower]::Say("OK DRAGSTART " + $ok)
  }
  elseif ($line -match '^BOUNDS\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$') {
    [InkPetFollower]::SetBounds([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
    [InkPetFollower]::Say("OK BOUNDS " + $Matches[1] + "," + $Matches[2] + "," + $Matches[3] + "," + $Matches[4])
  }
  elseif ($line -match '^RECT\s+(\d+)$') {
    [InkPetFollower]::Say("OK RECT " + [InkPetFollower]::RectReport([int64]$Matches[1]))
  }
  elseif ($line -match '^TARGET\s+(\d+)$') {
    [InkPetFollower]::SetTarget([int64]$Matches[1])
    [InkPetFollower]::Say("OK TARGET " + $Matches[1])
  }
  elseif ($line -match '^HITBOX\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$') {
    # silent on purpose: the main process refreshes this often, no need to echo it back
    [InkPetFollower]::SetHitbox([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
  }
  elseif ($line -match '^MASK\s+([0-9.]+)\s+(\d+)\s+(\d+)\s+([A-Za-z0-9+/=]+)$') {
    # silent like HITBOX: the main process re-sends it whenever the outline changes
    [void][InkPetFollower]::SetMask([double]$Matches[1], [int]$Matches[2], [int]$Matches[3], $Matches[4])
  }
  elseif ($line -match '^FIT\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$') {
    $moved = [InkPetFollower]::Fit([int64]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4], [int]$Matches[5])
    if ($moved) { [InkPetFollower]::Say("OK FIT " + $moved) }
  }
  elseif ($line -match '^FITCALC((\s+-?\d+){10})$') {
    $n = @($Matches[1].Trim() -split '\s+' | ForEach-Object { [int]$_ })
    [InkPetFollower]::Say("OK FITCALC " + [InkPetFollower]::FitCalc($n[0], $n[1], $n[2], $n[3], $n[4], $n[5], $n[6], $n[7], $n[8], $n[9]))
  }
  elseif ($line -match '^TESTHIT\s+(-?\d+)\s+(-?\d+)$') {
    [InkPetFollower]::Say("OK TESTHIT " + [InkPetFollower]::TestHit([int]$Matches[1], [int]$Matches[2]))
  }
  elseif ($line -match '^AUTO\s+([01])$') {
    [InkPetFollower]::SetAuto($Matches[1] -eq '1')
    [InkPetFollower]::Say("OK AUTO " + $Matches[1])
  }
  elseif ($line -match '^DRAGEND') {
    [InkPetFollower]::Stop()
    [InkPetFollower]::Say("OK DRAGEND")
  }
  elseif ($line -match '^QUIT') { break }
}
