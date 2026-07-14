package httpapi

import (
	"encoding/base64"
	"testing"
)

func TestParseCurl(t *testing.T) {
	input := `curl -X POST 'https://api.example.com/users?active=true' \
  -H 'Content-Type: application/json' \
  -H 'X-Trace: abc:def' \
  -u 'demo:secret' \
  --data-raw '{"name":"Ada"}'`

	got, err := ParseRequestText(input)
	if err != nil {
		t.Fatal(err)
	}
	if got.Format != "curl" || got.Method != "POST" || got.URL != "https://api.example.com/users?active=true" {
		t.Fatalf("unexpected request: %#v", got)
	}
	if got.Body != `{"name":"Ada"}` {
		t.Fatalf("unexpected body %q", got.Body)
	}
	if got.Headers["Content-Type"] != "application/json" || got.Headers["X-Trace"] != "abc:def" {
		t.Fatalf("unexpected headers: %#v", got.Headers)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("demo:secret"))
	if got.Headers["Authorization"] != wantAuth {
		t.Fatalf("unexpected auth header")
	}
}

func TestParseCurlInfersPostAndSupportsGetData(t *testing.T) {
	post, err := ParseRequestText(`curl example.com/items -d 'a=1' -d 'b=2'`)
	if err != nil {
		t.Fatal(err)
	}
	if post.Method != "POST" || post.Body != "a=1&b=2" || post.URL != "http://example.com/items" {
		t.Fatalf("unexpected POST: %#v", post)
	}

	get, err := ParseRequestText(`curl -G https://example.com/search --data 'q=go'`)
	if err != nil {
		t.Fatal(err)
	}
	if get.Method != "GET" || get.URL != "https://example.com/search?q=go" || get.Body != "" {
		t.Fatalf("unexpected GET: %#v", get)
	}
}

func TestParseCurlCompactOptions(t *testing.T) {
	got, err := ParseRequestText(`curl -fsSL -XPOST -HContent-Type:application/json -d'{"ok":true}' https://example.com`)
	if err != nil {
		t.Fatal(err)
	}
	if got.Method != "POST" || got.Headers["Content-Type"] != "application/json" || got.Body != `{"ok":true}` {
		t.Fatalf("unexpected request: %#v", got)
	}
}

func TestParseCurlRejectsUnsafeAndUnsupportedInputs(t *testing.T) {
	for _, input := range []string{
		`curl https://example.com --data @secret.json`,
		`curl https://example.com -F file=@secret.txt`,
		`curl https://example.com --output response.txt`,
	} {
		if _, err := ParseRequestText(input); err == nil {
			t.Fatalf("expected error for %q", input)
		}
	}
}

func TestParseRawHTTP(t *testing.T) {
	input := "POST /v1/users?active=true HTTP/1.1\r\n" +
		"Host: api.example.com\r\nContent-Type: application/json\r\nX-Trace: abc:def\r\n\r\n" +
		`{"name":"Ada"}`

	got, err := ParseRequestText(input)
	if err != nil {
		t.Fatal(err)
	}
	if got.Format != "http" || got.Method != "POST" || got.URL != "https://api.example.com/v1/users?active=true" {
		t.Fatalf("unexpected request: %#v", got)
	}
	if got.Headers["Content-Type"] != "application/json" || got.Headers["X-Trace"] != "abc:def" {
		t.Fatalf("unexpected headers: %#v", got.Headers)
	}
	if got.Body != `{"name":"Ada"}` {
		t.Fatalf("unexpected body %q", got.Body)
	}
}

func TestParseRawHTTPLocalhostUsesHTTP(t *testing.T) {
	got, err := ParseRequestText("GET /health HTTP/1.1\nHost: 127.0.0.1:4317")
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != "http://127.0.0.1:4317/health" {
		t.Fatalf("unexpected URL %q", got.URL)
	}
}

func TestParseRawHTTPRequiresHostForRelativeURL(t *testing.T) {
	if _, err := ParseRequestText("GET /health HTTP/1.1"); err == nil {
		t.Fatal("expected missing Host error")
	}
}
