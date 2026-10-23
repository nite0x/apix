import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './App';
import './styles.css';
import { getStyleNonce } from '@/lib/style-nonce';
// Radix scroll-lock styles use get-nonce's standard webpack nonce convention.
// Set it before rendering so the Go page can keep a strict style CSP.
const styleNonce = getStyleNonce();
if (styleNonce)
  (globalThis as typeof globalThis & { __webpack_nonce__?: string }).__webpack_nonce__ = styleNonce;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
