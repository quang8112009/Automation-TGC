/**
 * App routing. Public routes (/login, /register) sit outside the protected
 * layout. Everything else is wrapped by RequireAuth + the Layout shell. The
 * RealtimeProvider lives inside the authenticated area so the WebSocket only
 * opens for signed-in users. ADMIN-only routes are guarded by role.
 *
 * Pages are code-split with React.lazy so each route ships in its own chunk —
 * the initial bundle only carries the shell (auth + layout + the first route).
 * A lightweight <Suspense> fallback shows the shared skeleton while a chunk
 * loads. Login/Register stay eager (tiny, and they gate everything else).
 */
import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RealtimeProvider } from './realtime/RealtimeContext';
import { Loading } from './components/ui';
import { Login } from './pages/Login';
import { Register } from './pages/Register';

// Lazily-loaded routes (each becomes its own Vite chunk).
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Leads = lazy(() => import('./pages/Leads').then((m) => ({ default: m.Leads })));
const JobOrders = lazy(() => import('./pages/JobOrders').then((m) => ({ default: m.JobOrders })));
const Candidates = lazy(() => import('./pages/Candidates').then((m) => ({ default: m.Candidates })));
const CandidateDetail = lazy(() =>
  import('./pages/CandidateDetail').then((m) => ({ default: m.CandidateDetail })),
);
const AiConsultant = lazy(() => import('./pages/AiConsultant').then((m) => ({ default: m.AiConsultant })));
const InterviewPrep = lazy(() =>
  import('./pages/InterviewPrep').then((m) => ({ default: m.InterviewPrep })),
);
const Knowledge = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.Knowledge })));
const Strategy = lazy(() => import('./pages/Strategy').then((m) => ({ default: m.Strategy })));
const Drafts = lazy(() => import('./pages/Drafts').then((m) => ({ default: m.Drafts })));
const Publishing = lazy(() => import('./pages/Publishing').then((m) => ({ default: m.Publishing })));
const Insights = lazy(() => import('./pages/Insights').then((m) => ({ default: m.Insights })));
const Workflows = lazy(() => import('./pages/Workflows').then((m) => ({ default: m.Workflows })));
const PlatformTokens = lazy(() =>
  import('./pages/PlatformTokens').then((m) => ({ default: m.PlatformTokens })),
);
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const UserManagement = lazy(() =>
  import('./pages/UserManagement').then((m) => ({ default: m.UserManagement })),
);
const Autopilot = lazy(() => import('./pages/Autopilot').then((m) => ({ default: m.Autopilot })));
const Trends = lazy(() => import('./pages/Trends').then((m) => ({ default: m.Trends })));
const ContentPlans = lazy(() => import('./pages/ContentPlans').then((m) => ({ default: m.ContentPlans })));
const ContentStudio = lazy(() => import('./pages/ContentStudio').then((m) => ({ default: m.ContentStudio })));
const BrandAssets = lazy(() => import('./pages/BrandAssets').then((m) => ({ default: m.BrandAssets })));
const Analytics = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.Analytics })));
const Reports = lazy(() => import('./pages/Reports').then((m) => ({ default: m.Reports })));
const DocumentCatalog = lazy(() =>
  import('./pages/DocumentCatalog').then((m) => ({ default: m.DocumentCatalog })),
);
const Intake = lazy(() => import('./pages/Intake').then((m) => ({ default: m.Intake })));
const Partners = lazy(() => import('./pages/Partners').then((m) => ({ default: m.Partners })));
const FollowUps = lazy(() => import('./pages/FollowUps').then((m) => ({ default: m.FollowUps })));

function ProtectedShell() {
  return (
    <RequireAuth>
      <RealtimeProvider>
        <Layout />
      </RealtimeProvider>
    </RequireAuth>
  );
}

/** Suspense fallback for a lazily-loaded page chunk. */
function PageFallback() {
  return (
    <div className="content">
      <Loading label="Đang tải trang…" rows={5} />
    </div>
  );
}

export function App() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

        <Route element={<ProtectedShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/job-orders" element={<JobOrders />} />
          <Route path="/candidates" element={<Candidates />} />
          <Route path="/candidates/:id" element={<CandidateDetail />} />
          <Route path="/interview-prep" element={<InterviewPrep />} />
          <Route path="/intake" element={<Intake />} />
          <Route path="/follow-ups" element={<FollowUps />} />
          <Route
            path="/partners"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Partners />
              </RequireAuth>
            }
          />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/reports" element={<Reports />} />
          <Route
            path="/ai-consultant"
            element={
              <RequireAuth roles={['ADMIN']}>
                <AiConsultant />
              </RequireAuth>
            }
          />
          <Route
            path="/knowledge"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Knowledge />
              </RequireAuth>
            }
          />
          <Route
            path="/strategy"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Strategy />
              </RequireAuth>
            }
          />
          <Route
            path="/drafts"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Drafts />
              </RequireAuth>
            }
          />
          <Route
            path="/publishing"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Publishing />
              </RequireAuth>
            }
          />
          <Route
            path="/insights"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Insights />
              </RequireAuth>
            }
          />
          <Route
            path="/workflows"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Workflows />
              </RequireAuth>
            }
          />
          <Route
            path="/autopilot"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Autopilot />
              </RequireAuth>
            }
          />
          <Route
            path="/trends"
            element={
              <RequireAuth roles={['ADMIN']}>
                <Trends />
              </RequireAuth>
            }
          />
          <Route
            path="/content-plans"
            element={
              <RequireAuth roles={['ADMIN']}>
                <ContentPlans />
              </RequireAuth>
            }
          />
          <Route
            path="/content-studio"
            element={
              <RequireAuth roles={['ADMIN']}>
                <ContentStudio />
              </RequireAuth>
            }
          />
          <Route
            path="/brand-assets"
            element={
              <RequireAuth roles={['ADMIN']}>
                <BrandAssets />
              </RequireAuth>
            }
          />
          <Route
            path="/platform-tokens"
            element={
              <RequireAuth roles={['ADMIN']}>
                <PlatformTokens />
              </RequireAuth>
            }
          />
          <Route
            path="/document-catalog"
            element={
              <RequireAuth roles={['ADMIN']}>
                <DocumentCatalog />
              </RequireAuth>
            }
          />
          <Route
            path="/users"
            element={
              <RequireAuth roles={['ADMIN']}>
                <UserManagement />
              </RequireAuth>
            }
          />
          <Route path="/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
