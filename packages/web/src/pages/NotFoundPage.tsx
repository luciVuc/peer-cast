import { Link } from "react-router-dom";
import { IllustratedMessage } from "../components/IllustratedMessage";

export function NotFoundPage() {
  return (
    <IllustratedMessage
      icon="🧭"
      title="Page not found"
      description="The page you're looking for doesn't exist."
      action={
        <Link to="/" className="btn-primary">
          Go home
        </Link>
      }
    />
  );
}
