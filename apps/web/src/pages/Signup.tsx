import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Database } from 'lucide-react'
import { register, getAuthStatus } from '../lib/api'
import { useAuthStore } from '../stores/connections.store'

export function SignupPage() {
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [setupComplete, setSetupComplete] = useState(false)

  useEffect(() => {
    getAuthStatus()
      .then((res) => setSetupComplete(!res.needsSetup))
      .catch(() => setSetupComplete(false))
      .finally(() => setCheckingStatus(false))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    try {
      const res = await register(email, password)
      setAuth(res.token, res.user)
      navigate('/connections')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
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
          <p className="text-sm text-muted-foreground mt-1">Create the admin account</p>
        </div>

        {checkingStatus ? (
          <div className="bg-card border border-border rounded-lg p-6 text-sm text-muted-foreground text-center">
            Checking setup status…
          </div>
        ) : setupComplete ? (
          <div className="bg-card border border-border rounded-lg p-6 space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Setup is already complete. Sign in with your account instead.
            </p>
            <Link
              to="/login"
              className="block w-full py-2 bg-primary text-primary-foreground text-sm font-medium rounded hover:bg-primary/90 transition-colors"
            >
              Go to Sign In
            </Link>
          </div>
        ) : (
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
                minLength={8}
                className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="At least 8 characters"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">Confirm password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
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
              {loading ? 'Please wait…' : 'Create Account'}
            </button>
            <p className="text-xs text-muted-foreground text-center">
              This creates the super admin for this instance. Additional users are invited from Settings afterward.
            </p>
          </form>
        )}

        {!checkingStatus && !setupComplete && (
          <p className="text-xs text-muted-foreground text-center mt-4">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:underline">Sign in</Link>
          </p>
        )}
      </div>
    </div>
  )
}
