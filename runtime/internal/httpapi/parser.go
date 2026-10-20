package httpapi

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/mattn/go-shellwords"
)

// ParsedRequest is the normalized representation returned to the request editor.
type ParsedRequest struct {
	Format  string            `json:"format"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// ParseRequestText detects and parses a pasted curl command or raw HTTP/1.x request.
func ParseRequestText(input string) (*ParsedRequest, error) {
	input = strings.ReplaceAll(input, "\r\n", "\n")
	if strings.TrimSpace(input) == "" {
		return nil, fmt.Errorf("request text is empty")
	}

	input = strings.TrimLeft(input, "\n\t ")
	first := strings.TrimSpace(strings.SplitN(input, "\n", 2)[0])
	first = strings.TrimSpace(strings.TrimLeft(first, "$%#> "))
	if strings.HasPrefix(strings.ToLower(first), "curl ") || strings.EqualFold(first, "curl") ||
		strings.HasPrefix(strings.ToLower(first), "curl.exe ") {
		return parseCurl(input)
	}
	return parseRawHTTP(input)
}

func parseCurl(input string) (*ParsedRequest, error) {
	input = strings.TrimSpace(strings.TrimLeft(input, "$%#> "))
	input = strings.ReplaceAll(input, "\\\n", " ")

	parser := shellwords.NewParser()
	parser.ParseEnv = false
	parser.ParseBacktick = false
	args, err := parser.Parse(input)
	if err != nil {
		return nil, fmt.Errorf("invalid curl command: %w", err)
	}
	if len(args) == 0 || (args[0] != "curl" && !strings.EqualFold(args[0], "curl.exe")) {
		return nil, fmt.Errorf("expected a curl command")
	}

	result := &ParsedRequest{Format: "curl", Method: "GET", Headers: map[string]string{}}
	var data []string
	getWithData := false

	valueAfter := func(i *int, option string) (string, error) {
		(*i)++
		if *i >= len(args) {
			return "", fmt.Errorf("%s requires a value", option)
		}
		return args[*i], nil
	}

	for i := 1; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-X" || arg == "--request":
			value, err := valueAfter(&i, arg)
			if err != nil {
				return nil, err
			}
			result.Method = strings.ToUpper(value)
		case strings.HasPrefix(arg, "-X") && len(arg) > 2:
			result.Method = strings.ToUpper(arg[2:])
		case strings.HasPrefix(arg, "--request="):
			result.Method = strings.ToUpper(strings.TrimPrefix(arg, "--request="))
		case arg == "-H" || arg == "--header":
			value, err := valueAfter(&i, arg)
			if err != nil {
				return nil, err
			}
			if err := addCurlHeader(result.Headers, value); err != nil {
				return nil, err
			}
		case strings.HasPrefix(arg, "--header="):
			if err := addCurlHeader(result.Headers, strings.TrimPrefix(arg, "--header=")); err != nil {
				return nil, err
			}
		case strings.HasPrefix(arg, "-H") && len(arg) > 2:
			if err := addCurlHeader(result.Headers, arg[2:]); err != nil {
				return nil, err
			}
		case arg == "-d" || arg == "--data" || arg == "--data-ascii" || arg == "--data-binary" || arg == "--data-raw" || arg == "--data-urlencode":
			value, err := valueAfter(&i, arg)
			if err != nil {
				return nil, err
			}
			if arg != "--data-raw" && strings.HasPrefix(value, "@") {
				return nil, fmt.Errorf("%s with a file is not supported", arg)
			}
			data = append(data, value)
		case strings.HasPrefix(arg, "--data=") || strings.HasPrefix(arg, "--data-ascii=") || strings.HasPrefix(arg, "--data-binary=") || strings.HasPrefix(arg, "--data-raw=") || strings.HasPrefix(arg, "--data-urlencode="):
			name, value, _ := strings.Cut(arg, "=")
			if name != "--data-raw" && strings.HasPrefix(value, "@") {
				return nil, fmt.Errorf("%s with a file is not supported", name)
			}
			data = append(data, value)
		case strings.HasPrefix(arg, "-d") && len(arg) > 2:
			value := arg[2:]
			if strings.HasPrefix(value, "@") {
				return nil, fmt.Errorf("-d with a file is not supported")
			}
			data = append(data, value)
		case arg == "--url":
			value, err := valueAfter(&i, arg)
			if err != nil {
				return nil, err
			}
			result.URL = value
		case strings.HasPrefix(arg, "--url="):
			result.URL = strings.TrimPrefix(arg, "--url=")
		case arg == "-u" || arg == "--user":
			value, err := valueAfter(&i, arg)
			if err != nil {
				return nil, err
			}
			result.Headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(value))
		case strings.HasPrefix(arg, "--user="):
			value := strings.TrimPrefix(arg, "--user=")
			result.Headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(value))
		case strings.HasPrefix(arg, "-u") && len(arg) > 2:
			result.Headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(arg[2:]))
		case arg == "-G" || arg == "--get":
			getWithData = true
		case arg == "-I" || arg == "--head":
			result.Method = http.MethodHead
		case arg == "-L" || arg == "--location" || arg == "-s" || arg == "--silent" ||
			arg == "-S" || arg == "--show-error" || arg == "-k" || arg == "--insecure" ||
			arg == "--compressed" || arg == "-v" || arg == "--verbose" || arg == "-f" || arg == "--fail":
			// Transport/output flags do not change the normalized request fields.
		case isCurlNoopShortBundle(arg):
			// Common output/transport flags may be combined, e.g. -sS or -fsSL.
		case arg == "-F" || arg == "--form" || strings.HasPrefix(arg, "--form="):
			return nil, fmt.Errorf("multipart form data is not supported yet")
		case strings.HasPrefix(arg, "-"):
			return nil, fmt.Errorf("unsupported curl option %q", arg)
		default:
			if result.URL != "" {
				return nil, fmt.Errorf("multiple curl URLs are not supported")
			}
			result.URL = arg
		}
	}

	if result.URL == "" {
		return nil, fmt.Errorf("curl URL is required")
	}
	if !strings.Contains(result.URL, "://") {
		result.URL = "http://" + result.URL
	}
	if _, err := url.ParseRequestURI(result.URL); err != nil {
		return nil, fmt.Errorf("invalid curl URL: %w", err)
	}

	if len(data) > 0 {
		joined := strings.Join(data, "&")
		if getWithData {
			u, _ := url.Parse(result.URL)
			if u.RawQuery == "" {
				u.RawQuery = joined
			} else {
				u.RawQuery += "&" + joined
			}
			result.URL = u.String()
			result.Method = http.MethodGet
		} else {
			result.Body = joined
			if result.Method == http.MethodGet {
				result.Method = http.MethodPost
			}
		}
	}
	return result, nil
}

func isCurlNoopShortBundle(arg string) bool {
	if len(arg) < 3 || arg[0] != '-' || arg[1] == '-' {
		return false
	}
	for _, flag := range arg[1:] {
		if !strings.ContainsRune("sSLkvf", flag) {
			return false
		}
	}
	return true
}

func addCurlHeader(headers map[string]string, value string) error {
	name, headerValue, ok := strings.Cut(value, ":")
	name = strings.TrimSpace(name)
	if !ok || name == "" {
		return fmt.Errorf("invalid curl header %q", value)
	}
	headers[http.CanonicalHeaderKey(name)] = strings.TrimSpace(headerValue)
	return nil
}

func parseRawHTTP(input string) (*ParsedRequest, error) {
	head, body := splitHTTPBody(input)
	req, err := http.ReadRequest(bufio.NewReader(strings.NewReader(head + "\r\n\r\n")))
	if err != nil {
		return nil, fmt.Errorf("invalid HTTP request: %w", err)
	}
	if req.Body != nil {
		_ = req.Body.Close()
	}

	requestURL := req.URL.String()
	if !req.URL.IsAbs() {
		if req.Host == "" {
			return nil, fmt.Errorf("HTTP request with a relative path requires a Host header")
		}
		scheme := "https"
		hostname := strings.Split(req.Host, ":")[0]
		if hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1" {
			scheme = "http"
		}
		requestURL = scheme + "://" + req.Host + req.URL.RequestURI()
	}

	headers := make(map[string]string, len(req.Header))
	for name, values := range req.Header {
		headers[name] = strings.Join(values, ", ")
	}
	return &ParsedRequest{Format: "http", Method: req.Method, URL: requestURL, Headers: headers, Body: body}, nil
}

func splitHTTPBody(input string) (string, string) {
	if head, body, ok := strings.Cut(input, "\n\n"); ok {
		return strings.TrimRight(head, "\n"), body
	}
	return strings.TrimRight(input, "\n"), ""
}
