import React, { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Database } from 'lucide-react'
import { login, getAuthStatus } from '../lib/api'
import { useAuthStore } from '../stores/connections.store'

export function LoginPage() {
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getAuthStatus()
      .then((res) => {
        if (res.needsSetup) navigate('/signup', { replace: true })
      })
      .catch(() => {})
  }, [navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await login(email, password)
      setAuth(res.token, res.user)
      navigate('/connections')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
            <Database className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">PivotDB</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to your account</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-card border border-border rounded-lg p-6 space-y-4">
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="••••••••"
            />
          </div>
          {error && <p className="text-xs text-red-400 bg-red-500/10 rounded p-2">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-primary text-primary-foreground text-sm font-medium rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading ? 'Please wait…' : 'Sign In'}
          </button>
        </form>
        <p className="text-xs text-muted-foreground text-center mt-4">
          Setting up this instance for the first time?{' '}
          <Link to="/signup" className="text-primary hover:underline">Create the admin account</Link>
        </p>
      </div>
    </div>
  )
}
