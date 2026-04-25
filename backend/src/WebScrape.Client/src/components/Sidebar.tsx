import { NavLink } from 'react-router-dom';
import { useLogout } from '../api/mutations';

export default function Sidebar() {
  const logout = useLogout();
  return (
    <nav className="sidebar">
      <NavLink to="/tasks" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        Tasks
      </NavLink>
      <NavLink to="/workers" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        Workers
      </NavLink>
      <NavLink to="/keys" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
        API Keys
      </NavLink>
      <div className="sidebar-spacer" />
      <button
        className="btn btn-ghost btn-sm sidebar-logout"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        Sign out
      </button>
    </nav>
  );
}
