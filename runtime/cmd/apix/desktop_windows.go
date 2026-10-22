//go:build windows

package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

var user32 = windows.NewLazySystemDLL("user32.dll")

func desktopInstanceName(dataDir string) string {
	return fmt.Sprintf("Local\\ApixDesktop-%x", sha256.Sum256([]byte(strings.ToLower(filepath.Clean(dataDir)))))
}

func checkWebViewRuntime() error {
	version, err := webviewloader.GetInstalledVersion()
	if err != nil {
		return fmt.Errorf("无法检测 Microsoft Edge WebView2 Runtime：%w", err)
	}
	if version == "" {
		return errors.New("未安装 Microsoft Edge WebView2 Runtime。请从 https://developer.microsoft.com/microsoft-edge/webview2/ 下载 Evergreen Runtime 后重试")
	}
	return nil
}

// A named property identifies this profile's window without relying on its
// title, which may change, or trusting stale window handles saved on disk.
type windowSearch struct {
	property   *uint16
	executable string
	found      uintptr
}

var desktopSearchMu sync.Mutex
var desktopSearch *windowSearch

var enumDesktopWindows = windows.NewCallback(func(hwnd, _ uintptr) uintptr {
	search := desktopSearch
	value, _, _ := user32.NewProc("GetPropW").Call(hwnd, uintptr(unsafe.Pointer(search.property)))
	if value == 0 {
		return 1
	}
	var pid uint32
	user32.NewProc("GetWindowThreadProcessId").Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if !ownedProcess(pid, search.executable) {
		return 1
	}
	search.found = hwnd
	return 0
})

func desktopWindow(instanceName, executable string) uintptr {
	desktopSearchMu.Lock()
	defer desktopSearchMu.Unlock()
	property, _ := windows.UTF16PtrFromString(instanceName)
	search := windowSearch{property: property, executable: executable}
	desktopSearch = &search
	defer func() { desktopSearch = nil }()
	_ = windows.EnumWindows(enumDesktopWindows, nil)
	return search.found
}

func focusDesktop(instanceName, executable string) error {
	deadline := time.Now().Add(35 * time.Second)
	for time.Now().Before(deadline) {
		if hwnd := desktopWindow(instanceName, executable); hwnd != 0 {
			iconic, _, _ := user32.NewProc("IsIconic").Call(hwnd)
			show := uintptr(5) // SW_SHOW preserves an already maximized window.
			if iconic != 0 {
				show = 9 // SW_RESTORE
			}
			user32.NewProc("ShowWindow").Call(hwnd, show)
			user32.NewProc("SetForegroundWindow").Call(hwnd)
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return errors.New("Apix 桌面窗口仍在启动，请查看 startup.log 后重试")
}

func runDesktop(dataDir, workspaceURL, instanceName string) error {
	profile := filepath.Join(filepath.Dir(dataDir), "webview2")
	if err := os.MkdirAll(profile, 0700); err != nil {
		return fmt.Errorf("创建 WebView2 缓存目录失败：%w", err)
	}
	// Set DPI awareness before creating the first window; older Windows falls
	// back to system DPI awareness. No C/C++ toolchain or external loader DLL.
	if proc := user32.NewProc("SetProcessDpiAwarenessContext"); proc.Find() == nil {
		proc.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
	} else {
		user32.NewProc("SetProcessDPIAware").Call()
	}
	width, height := uintptr(1440), uintptr(960)
	screenWidth, _, _ := user32.NewProc("GetSystemMetrics").Call(0)
	screenHeight, _, _ := user32.NewProc("GetSystemMetrics").Call(1)
	if screenWidth < width+80 {
		width = screenWidth * 9 / 10
	}
	if screenHeight < height+100 {
		height = screenHeight * 8 / 10
	}
	view := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  profile,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title: "Apix", Width: uint(width), Height: uint(height), Center: true,
		},
	})
	if view == nil {
		return fmt.Errorf("创建 WebView2 桌面窗口失败。请修复 Microsoft Edge WebView2 Runtime，并查看 %s", filepath.Join(dataDir, "startup.log"))
	}
	defer view.Destroy()
	property, _ := windows.UTF16PtrFromString(instanceName)
	hwnd := uintptr(view.Window())
	ok, _, err := user32.NewProc("SetPropW").Call(hwnd, uintptr(unsafe.Pointer(property)), 1)
	if ok == 0 {
		return fmt.Errorf("标记 Apix 桌面窗口失败：%w", err)
	}
	// Windows removes window properties when WM_CLOSE destroys the window.
	view.Navigate(workspaceURL + "/")
	view.Run()
	return nil
}
