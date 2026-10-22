//go:build windows

// Apix hosts the embedded workspace in a native Microsoft Edge WebView2 window.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func main() {
	if err := launch(); err != nil {
		message, _ := windows.UTF16PtrFromString(err.Error())
		title, _ := windows.UTF16PtrFromString("Apix")
		windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(
			0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
		os.Exit(1)
	}
}

func launch() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	address, err := desktopAddress(os.Getenv("APIX_ADDR"))
	if err != nil {
		return err
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return errors.New("无法定位 Windows 本地应用数据目录")
	}
	dataDir := filepath.Join(local, "Apix", "data")
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	runtimePath := filepath.Join(filepath.Dir(executable), "apix-runtime.exe")
	if _, err := os.Stat(runtimePath); err != nil {
		return fmt.Errorf("找不到后端程序：%w", err)
	}

	logFile, err := os.OpenFile(filepath.Join(dataDir, "startup.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	log.SetOutput(logFile)
	defer log.SetOutput(os.Stderr)

	background := len(os.Args) == 2 && os.Args[1] == "--background"
	if len(os.Args) > 1 && !background {
		return errors.New("用法：Apix.exe [--background]")
	}
	// Keep the desktop mutex alive for the entire window lifetime. The backend
	// has a separate, short-lived startup lock so --background never blocks on UI.
	if !background {
		instanceName := desktopInstanceName(dataDir)
		name, _ := windows.UTF16PtrFromString(instanceName)
		instance, err := windows.CreateMutex(nil, false, name)
		if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return err
		}
		defer windows.CloseHandle(instance)
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return focusDesktop(instanceName, executable)
		}
		if err := checkWebViewRuntime(); err != nil {
			return err
		}
	}
	if err := ensureRuntime(dataDir, runtimePath, address, logFile); err != nil {
		return fmt.Errorf("%w。请查看日志：%s", err, filepath.Join(dataDir, "startup.log"))
	}
	if background {
		return nil
	}
	return runDesktop(dataDir, "http://"+address, desktopInstanceName(dataDir))
}

func ensureRuntime(dataDir, runtimePath, address string, logFile *os.File) error {
	name, _ := windows.UTF16PtrFromString(fmt.Sprintf("Local\\Apix-%x", sha256.Sum256([]byte(strings.ToLower(dataDir)))))
	mutex, err := windows.CreateMutex(nil, false, name)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return err
	}
	defer windows.CloseHandle(mutex)
	wait, err := windows.WaitForSingleObject(mutex, 35000)
	if err != nil {
		return err
	}
	if wait != windows.WAIT_OBJECT_0 && wait != windows.WAIT_ABANDONED {
		return errors.New("Apix 正在启动，请稍后重试")
	}
	defer windows.ReleaseMutex(mutex)

	pidFile := filepath.Join(dataDir, "runtime.pid")
	pidBytes, _ := os.ReadFile(pidFile)
	pid, _ := strconv.ParseUint(strings.TrimSpace(string(pidBytes)), 10, 32)
	if !ownedProcess(uint32(pid), runtimePath) {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			return fmt.Errorf("Apix 启动端口 %s 已被其他程序占用，请关闭占用程序后重试", address)
		}
		listener.Close()
		command := exec.Command(runtimePath)
		command.Dir = filepath.Dir(runtimePath)
		command.Env = append(os.Environ(), "APIX_ADDR="+address, "APIX_DB_PATH="+filepath.Join(dataDir, "apix.db"), "APIX_LOG_PATH="+filepath.Join(dataDir, "runtime.log"))
		command.Stdout, command.Stderr = logFile, logFile
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
		if err := command.Start(); err != nil {
			return fmt.Errorf("启动后端失败：%w", err)
		}
		if err := os.WriteFile(pidFile, []byte(strconv.Itoa(command.Process.Pid)), 0600); err != nil {
			command.Process.Kill()
			command.Wait()
			return err
		}
		command.Process.Release()
	}
	return waitReady("http://" + address)
}

func ownedProcess(pid uint32, expectedPath string) bool {
	if pid == 0 {
		return false
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	state, err := windows.WaitForSingleObject(process, 0)
	if err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		return false
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if windows.QueryFullProcessImageName(process, 0, &buffer[0], &size) != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(windows.UTF16ToString(buffer[:size])), filepath.Clean(expectedPath))
}

func waitReady(workspaceURL string) error {
	client := http.Client{Timeout: 500 * time.Millisecond, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get(workspaceURL + "/health")
		if err == nil {
			var health struct {
				Service string `json:"service"`
				Status  string `json:"status"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&health)
			response.Body.Close()
			if decodeErr == nil && response.StatusCode == 200 && health.Service == "apix-runtime" && health.Status == "ok" {
				return nil
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	return errors.New("后端未能在 30 秒内就绪")
}
