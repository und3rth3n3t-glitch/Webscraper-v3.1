import { type FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import axios from 'axios';
import { useLogin } from '../api/mutations';
import { useMe } from '../api/queries';

export default function Login() {
  const [email, setEmail] = useState('admin@local');
  const [password, setPassword] = useState('admin');
  const login = useLogin();
  const { data: me, isPending } = useMe();

  if (!isPending && me) return <Navigate to="/tasks" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password });
  };

  const errMsg = (() => {
    const e = login.error;
    if (!e) return null;
    if (axios.isAxiosError(e)) {
      const data = e.response?.data as { error?: string } | undefined;
      return data?.error ?? 'Sign in failed.';
    }
    return 'Sign in failed.';
  })();

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={onSubmit}>
        <div className="login-title">WebScrape</div>
        {errMsg && <div className="danger-banner">{errMsg}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="form-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="form-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" className="btn btn-primary btn-full" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
