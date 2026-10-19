//go:build windows

// Apix starts the standalone runtime and opens its Web workspace.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
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

const address = "127.0.0.1:4319"
const workspaceURL = "http://" + address

func main() {
	if err := launch(); err != nil {
		message, _ := windows.UTF16PtrFromString(err.Error())
		title, _ := windows.UTF16PtrFromString("Apix")
		windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(
			0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
	}
}

func launch() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
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
		logFile, err := os.OpenFile(filepath.Join(dataDir, "startup.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		defer logFile.Close()
		command := exec.Command(runtimePath)
		command.Dir = filepath.Dir(executable)
		command.Env = append(os.Environ(), "APIX_ADDR="+address, "APIX_DB_PATH="+filepath.Join(dataDir, "apix.db"), "APIX_LOG_PATH="+filepath.Join(dataDir, "runtime.log"))
		command.Stdout, command.Stderr = logFile, logFile
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
		if err := command.Start(); err != nil {
			return fmt.Errorf("启动后端失败：%w", err)
		}
		if err := os.WriteFile(pidFile, []byte(strconv.Itoa(command.Process.Pid)), 0600); err != nil {
			command.Process.Kill()
			return err
		}
		command.Process.Release()
	}
	if err := waitReady(); err != nil {
		return fmt.Errorf("%w。请查看日志：%s", err, filepath.Join(dataDir, "startup.log"))
	}
	if len(os.Args) > 1 && os.Args[1] == "--background" {
		return nil
	}
	command := exec.Command(filepath.Join(os.Getenv("WINDIR"), "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", workspaceURL)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if err := command.Start(); err != nil {
		return fmt.Errorf("打开浏览器失败，请手动访问 %s：%w", workspaceURL, err)
	}
	return command.Process.Release()
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

func waitReady() error {
	client := http.Client{Timeout: 500 * time.Millisecond}
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
