//go:build windows

package main

import "testing"

func TestDesktopAddress(t *testing.T) {
	for _, value := range []string{"", "127.0.0.1:4319", "127.0.0.1:18432"} {
		got, err := desktopAddress(value)
		if err != nil || got == "" {
			t.Fatalf("desktopAddress(%q) = %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"0.0.0.0:4319", "192.168.1.2:4319", "localhost:4319", "127.0.0.1:0", "127.0.0.1:65536", "http://127.0.0.1:4319", "127.0.0.1:abc"} {
		if _, err := desktopAddress(value); err == nil {
			t.Errorf("accepted non-loopback or invalid address %q", value)
		}
	}
}
