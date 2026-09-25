import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { routes } from "./routes";

/**
 * The data router.
 *
 * Created once at module scope — NOT inside the component. React Router keeps
 * router state internally, so re-creating it on every render would throw away
 * the navigation state and remount the whole tree. Module scope also keeps it
 * outside React, which is what the React Router docs require.
 */
const router = createBrowserRouter(routes);

export default function App() {
  return <RouterProvider router={router} />;
}
