export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ApiParameter {
  name: string
  location: 'path' | 'query' | 'header'
  type: string
  required?: boolean
  description?: string
  defaultValue?: string
}

export interface ApiBinding {
  name: string
  direction: 'in' | 'out'
  source: string
}

export interface ApiRule {
  id: string
  label: string
  enabled: boolean
  triggered?: boolean
}

export interface ApiHistoryItem {
  id: string
  status: number
  label: string
  time: string
  durationMs?: number
}

export interface ApiDefinition {
  id: string
  collectionId: string
  collectionName: string
  name: string
  method: ApiMethod
  url: string
  description: string
  source: 'fixture' | 'backend'
  aiUsage?: { count: number; succeeded: number; failed: number; averageMs: number }
  parameters: ApiParameter[]
  bindings: ApiBinding[]
  rules: ApiRule[]
  history: ApiHistoryItem[]
  responseSchema?: Record<string, string>
}

export interface ApiCollectionGroup {
  id: string
  name: string
  icon: 'lock' | 'users' | 'file'
  apis: ApiDefinition[]
}

const authApis: ApiDefinition[] = [
  {
    id: 'login', collectionId: 'auth', collectionName: 'Auth Service', name: 'Login', method: 'POST',
    url: '{{base_url}}/auth/login', source: 'fixture',
    description: 'Authenticates a user and returns a short-lived bearer token for subsequent requests.',
    aiUsage: { count: 12, succeeded: 11, failed: 1, averageMs: 284 },
    parameters: [
      { name: 'email', location: 'query', type: 'string', required: true, description: 'Account email' },
      { name: 'password', location: 'query', type: 'string', required: true, description: 'Account password' },
    ],
    bindings: [{ name: 'token', direction: 'out', source: '.token' }],
    rules: [{ id: 'auth-4xx', label: 'Pause if response is 4xx', enabled: false }],
    history: [
      { id: 'h-login-1', status: 200, label: 'POST /auth/login · by AI', time: '09:31', durationMs: 284 },
      { id: 'h-login-2', status: 401, label: 'POST /auth/login · manual', time: 'yesterday', durationMs: 176 },
    ],
    responseSchema: { token: 'string', expires_in: 'integer', user_id: 'integer' },
  },
  {
    id: 'refresh', collectionId: 'auth', collectionName: 'Auth Service', name: 'Refresh token', method: 'POST',
    url: '{{base_url}}/auth/refresh', source: 'fixture', description: 'Exchanges a refresh token for a new bearer token.',
    parameters: [], bindings: [{ name: 'token', direction: 'out', source: '.token' }], rules: [], history: [],
  },
  {
    id: 'logout', collectionId: 'auth', collectionName: 'Auth Service', name: 'Logout', method: 'POST',
    url: '{{base_url}}/auth/logout', source: 'fixture', description: 'Revokes the current session token.',
    parameters: [], bindings: [{ name: 'token', direction: 'in', source: 'POST /auth/login · .token' }], rules: [], history: [],
  },
]

const userApis: ApiDefinition[] = [
  {
    id: 'list-users', collectionId: 'users', collectionName: 'Users API', name: 'List users', method: 'GET',
    url: '{{base_url}}/api/v1/users', source: 'fixture',
    description: 'Returns users visible to the current tenant. Supports filtering by role and account status.',
    aiUsage: { count: 8, succeeded: 7, failed: 1, averageMs: 236 },
    parameters: [
      { name: 'role', location: 'query', type: 'string', description: 'Filter by user role', defaultValue: 'admin' },
      { name: 'status', location: 'query', type: 'string', description: 'Filter by account status' },
    ],
    bindings: [{ name: 'token', direction: 'in', source: 'POST /auth/login · .token' }],
    rules: [
      { id: 'r-prod-users', label: 'Pause before GET /users in production', enabled: true, triggered: true },
      { id: 'users-4xx', label: 'Pause if response is 4xx', enabled: false },
    ],
    history: [
      { id: 'h-users-1', status: 200, label: 'GET /users?role=admin · by AI', time: '09:31', durationMs: 241 },
      { id: 'h-users-2', status: 200, label: 'GET /users · manual', time: 'yesterday', durationMs: 198 },
    ],
    responseSchema: { items: 'User[]', total: 'integer', next_cursor: 'string | null' },
  },
  {
    id: 'user-detail', collectionId: 'users', collectionName: 'Users API', name: 'User detail', method: 'GET',
    url: '{{base_url}}/api/v1/users/:id', source: 'fixture',
    description: 'Returns the full profile of a single user by ID. Requires users:read scope.',
    aiUsage: { count: 5, succeeded: 4, failed: 1, averageMs: 231 },
    parameters: [
      { name: 'id', location: 'path', type: 'integer', required: true, description: 'User ID, can resolve from {{userId}}', defaultValue: '42' },
      { name: 'include_deleted', location: 'query', type: 'boolean', description: 'Include soft-deleted users', defaultValue: 'false' },
    ],
    bindings: [
      { name: 'token', direction: 'in', source: 'POST /auth/login · .token' },
      { name: 'userId', direction: 'in', source: 'POST /auth/login · .user.id' },
      { name: 'lastViewedUser', direction: 'out', source: '.id' },
    ],
    rules: [
      { id: 'r-prod-users', label: 'Pause before GET /users in production', enabled: true, triggered: true },
      { id: 'users-4xx', label: 'Pause if response is 4xx', enabled: false },
    ],
    history: [
      { id: 'h-detail-1', status: 200, label: 'GET /users/42 · by AI', time: '09:31', durationMs: 231 },
      { id: 'h-detail-2', status: 200, label: 'GET /users/38 · by AI', time: '09:28', durationMs: 198 },
      { id: 'h-detail-3', status: 404, label: 'GET /users/99 · by AI', time: '09:15', durationMs: 112 },
      { id: 'h-detail-4', status: 200, label: 'GET /users/42 · manual', time: 'yesterday' },
    ],
    responseSchema: { id: 'integer', name: 'string', email: 'string', role: '"admin" | "user"', tenant_id: 'integer' },
  },
  {
    id: 'create-user', collectionId: 'users', collectionName: 'Users API', name: 'Create user', method: 'POST',
    url: '{{base_url}}/api/v1/users', source: 'fixture', description: 'Creates a user in the active tenant.',
    parameters: [], bindings: [{ name: 'token', direction: 'in', source: 'POST /auth/login · .token' }], rules: [], history: [],
  },
  {
    id: 'delete-user', collectionId: 'users', collectionName: 'Users API', name: 'Delete user', method: 'DELETE',
    url: '{{base_url}}/api/v1/users/:id', source: 'fixture', description: 'Deletes a user after explicit confirmation.',
    parameters: [{ name: 'id', location: 'path', type: 'integer', required: true }], bindings: [],
    rules: [{ id: 'r-delete', label: 'Pause before DELETE', enabled: true }], history: [],
  },
]

const postApis: ApiDefinition[] = [
  {
    id: 'list-posts', collectionId: 'posts', collectionName: 'Posts API', name: 'List posts', method: 'GET',
    url: '{{base_url}}/posts', source: 'fixture', description: 'Lists published posts.', parameters: [], bindings: [], rules: [], history: [],
  },
  {
    id: 'create-post', collectionId: 'posts', collectionName: 'Posts API', name: 'Create post', method: 'POST',
    url: '{{base_url}}/posts', source: 'fixture', description: 'Creates and publishes a post.',
    aiUsage: { count: 5, succeeded: 5, failed: 0, averageMs: 312 }, parameters: [], bindings: [], rules: [],
    history: [{ id: 'h-posts-1', status: 201, label: 'POST /posts · by AI', time: '09:18', durationMs: 312 }],
  },
  {
    id: 'update-post', collectionId: 'posts', collectionName: 'Posts API', name: 'Update post', method: 'PUT',
    url: '{{base_url}}/posts/:id', source: 'fixture', description: 'Updates an existing post.', parameters: [], bindings: [], rules: [], history: [],
  },
  {
    id: 'delete-post', collectionId: 'posts', collectionName: 'Posts API', name: 'Delete post', method: 'DELETE',
    url: '{{base_url}}/posts/:id', source: 'fixture', description: 'Deletes a post after explicit confirmation.', parameters: [], bindings: [],
    rules: [{ id: 'r-delete', label: 'Pause before DELETE', enabled: true }], history: [],
  },
]

export const fixtureCatalog: ApiCollectionGroup[] = [
  { id: 'auth', name: 'Auth Service', icon: 'lock', apis: authApis },
  { id: 'users', name: 'Users API', icon: 'users', apis: userApis },
  { id: 'posts', name: 'Posts API', icon: 'file', apis: postApis },
]

export function allApis(catalog: ApiCollectionGroup[]): ApiDefinition[] {
  return catalog.flatMap((collection) => collection.apis)
}

