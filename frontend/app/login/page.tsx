import { LoginScreen } from "@/components/auth/login-screen";

// Sign-in is never indexed, and nothing on it should leak where a person came from.
export const metadata = {
  title: "Sign in · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return <LoginScreen />;
}
