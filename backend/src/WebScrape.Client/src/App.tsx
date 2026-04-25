import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useMe } from './api/queries';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import ApiKeys from './pages/ApiKeys';
import Workers from './pages/Workers';
import Tasks from './pages/Tasks';
import RunDetail from './pages/RunDetail';
import Configs from './pages/Configs';
import ConfigEditor from './pages/ConfigEditor';
import TaskEditor from './pages/TaskEditor';
import RunBatchDetail from './pages/RunBatchDetail';

function AuthShell() {
  const { data: me, isPending } = useMe();
  const location = useLocation();

  if (isPending) return null;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <div className="app">
      <header className="header">
        <h1 style={{ color: 'white', fontSize: 'var(--font-size-xl)', fontWeight: 700, letterSpacing: '-0.3px' }}>
          WebScrape
        </h1>
        <span className="header-version">{me.email}</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar />
        <main className="app-content" style={{ flex: 1 }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AuthShell />}>
        <Route index element={<Navigate to="/tasks" replace />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/configs" element={<Configs />} />
        <Route path="/configs/new" element={<ConfigEditor />} />
        <Route path="/configs/:id/edit" element={<ConfigEditor />} />
        <Route path="/tasks/new" element={<TaskEditor />} />
        <Route path="/tasks/:id/edit" element={<TaskEditor />} />
        <Route path="/run-batches/:id" element={<RunBatchDetail />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/keys" element={<ApiKeys />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Route>
    </Routes>
  );
}
