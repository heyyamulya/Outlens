// Landing page (designed in Figma Make, adapted for this app). Its styles live in
// app/landing.css, scoped under .landing-root so they don't affect the camera app.
import type { Metadata } from "next";
import type { ReactNode, SVGProps } from "react";
import "./landing.css";

export const metadata: Metadata = {
  title: "Outlens: color becomes clear",
};

type IconName =
  | "camera"
  | "tap"
  | "sound"
  | "shirt"
  | "food"
  | "light"
  | "chart"
  | "arrow"
  | "shield"
  | "spark";

const iconPaths: Record<IconName, ReactNode> = {
  camera: (
    <>
      <path d="M8.5 6.5 10 4h4l1.5 2.5H19A2.5 2.5 0 0 1 21.5 9v8A2.5 2.5 0 0 1 19 19.5H5A2.5 2.5 0 0 1 2.5 17V9A2.5 2.5 0 0 1 5 6.5h3.5Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  tap: (
    <>
      <path d="M9 11V5.5a2 2 0 0 1 4 0V10" />
      <path d="M13 9.5a2 2 0 0 1 4 0v1.25" />
      <path d="M17 10.5a2 2 0 0 1 4 0V14c0 4.5-2.5 7-7 7h-1.1a6 6 0 0 1-4.25-1.75L4 14.6a2 2 0 0 1 2.83-2.83L9 14" />
    </>
  ),
  sound: (
    <>
      <path d="M5 9v6h4l5 4V5L9 9H5Z" />
      <path d="M17 9a4.2 4.2 0 0 1 0 6M19.5 6.5a7.7 7.7 0 0 1 0 11" />
    </>
  ),
  shirt: <path d="m8 4-5 3 2 4 3-1v10h8V10l3 1 2-4-5-3a4.8 4.8 0 0 1-8 0Z" />,
  food: (
    <>
      <path d="M4 4v7a3 3 0 0 0 3 3h1V4M6 4v6M8 4v6M7 14v6" />
      <path d="M16 4v16M16 12c3 0 4-2 4-4V4c-2 0-4 1.5-4 4" />
    </>
  ),
  light: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="5" />
      <circle cx="12" cy="7.5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="16.5" r="1.5" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V4M4 20h17" />
      <path d="m7 15 4-4 3 2 5-6" />
    </>
  ),
  arrow: <path d="M5 12h14M14 7l5 5-5 5" />,
  shield: <path d="M12 2.5 20 6v5c0 5-3.2 8.5-8 10.5C7.2 19.5 4 16 4 11V6l8-3.5ZM8.5 12l2.2 2.2 4.8-5" />,
  spark: <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2L10 9l2-6.5Z" />,
};

function Icon({
  name,
  className = "size-6",
  ...props
}: { name: IconName; className?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {iconPaths[name]}
    </svg>
  );
}

function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`page-container ${className}`}>{children}</div>;
}

function ButtonLink({
  children,
  href,
  variant = "primary",
  label,
}: {
  children: ReactNode;
  href: string;
  variant?: "primary" | "secondary" | "dark";
  label?: string;
}) {
  return (
    <a href={href} className={`button button-${variant}`} aria-label={label}>
      {children}
      <Icon name="arrow" className="size-5" />
    </a>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
  align = "left",
}: {
  eyebrow: string;
  title: string;
  body?: string;
  align?: "left" | "center";
}) {
  return (
    <div className={`section-heading ${align === "center" ? "text-center mx-auto" : ""}`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {body && <p className="section-copy">{body}</p>}
    </div>
  );
}

const steps = [
  { icon: "camera" as const, number: "01", title: "Look", text: "Look naturally at the object you want to understand." },
  { icon: "tap" as const, number: "02", title: "Select", text: "Use a simple gesture to choose the object in view." },
  {
    icon: "sound" as const,
    number: "03",
    title: "Understand",
    text: "See a blue outline, color name, plain-language description, and hear it aloud.",
  },
];

const helpCards = [
  { icon: "shirt" as const, title: "Clothing", text: "Coordinate an outfit with clear color names." },
  { icon: "food" as const, title: "Food", text: "Understand visual color cues while cooking or shopping." },
  { icon: "light" as const, title: "Device indicator lights", text: "Interpret labeled device states with more context." },
  { icon: "chart" as const, title: "Charts and maps", text: "Identify color-coded regions and data series." },
];

function OutlensMark({ className = "" }: { className?: string }) {
  return (
    <span className={`outlens-mark ${className}`} aria-hidden="true">
      <span />
    </span>
  );
}

function HeroGlasses() {
  return (
    <div className="glasses-stage" aria-hidden="true">
      <div className="orb orb-one" />
      <div className="orb orb-two" />
    </div>
  );
}

export default function Home() {
  return (
    <div className="landing-root site-shell min-h-full flex-1">
      <nav className="nav" aria-label="Main navigation">
        <Container className="nav-inner">
          <a className="wordmark" href="#" aria-label="Outlens home">
            <OutlensMark className="wordmark-symbol" />
            Outlens
          </a>
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#help">Where it helps</a>
            <a href="#account">Your Outlens</a>
          </div>
          <a className="nav-cta" href="/explore">Try the demo <Icon name="arrow" className="size-4" /></a>
        </Container>
      </nav>

      <main>
        <section className="hero">
          <Container className="hero-grid">
            <div className="hero-copy">
              <p className="eyebrow">Vision, with context</p>
              <h1>Color becomes <span className="blue-highlight">clear.</span></h1>
              <p className="hero-subhead">
                Outlens is a concept for intelligent glasses that outlines what you look at and explains its color,
                visually and out loud.
              </p>
              <div className="button-row">
                <ButtonLink href="/explore">Try the live demo</ButtonLink>
                <ButtonLink href="#how" variant="secondary">See how it works</ButtonLink>
              </div>
              <p className="hero-detail"><Icon name="spark" className="size-5" /> A hackathon vision for the next interface.</p>
            </div>
            <HeroGlasses />
          </Container>
        </section>

        <section className="problem-section">
          <Container className="problem-grid">
            <p className="eyebrow">A different approach</p>
            <div>
              <h2>Color filters change how colors look. <span>They don't tell you what a color means.</span></h2>
              <p>
                Many people with color-vision deficiency confuse certain colors, especially some reds and greens.
                And color-vision deficiency does not mean everyone sees in grayscale. Outlens adds language and
                context, not just a filter.
              </p>
            </div>
          </Container>
        </section>

        <section id="how" className="section pale-section">
          <Container>
            <SectionHeading
              eyebrow="How it works"
              title="From a glance to an answer."
              body="A hands-free flow designed for a future pair of intelligent glasses."
              align="center"
            />
            <div className="steps-grid">
              {steps.map((step, index) => (
                <div className="step-wrap" key={step.title}>
                  <article className="step-card">
                    <div className="step-top">
                      <span className="icon-box"><Icon name={step.icon} /></span>
                      <span className="step-number">{step.number}</span>
                    </div>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </article>
                  {index < steps.length - 1 && <span className="step-connector" aria-hidden="true"><Icon name="arrow" className="size-5" /></span>}
                </div>
              ))}
            </div>
          </Container>
        </section>

        <section className="section experience-section">
          <Container>
            <SectionHeading
              eyebrow="The experience"
              title="Clarity, revealed step by step."
              body="Introduced gradually, always under your control."
            />
            <div className="reveal-flow product-reveal-flow">
              <article className="reveal-card">
                <div className="reveal-preview preview-outline">
                  <img src="/outlens-apple-outlined.svg" alt="Dimensional red and green apple fully traced with a blue edge outline" />
                  <span className="scan-dot" />
                </div>
                <div className="reveal-copy"><span>1</span><div><h3>Object outline</h3><p>Know exactly what is selected.</p></div></div>
              </article>
              <span className="flow-arrow"><Icon name="arrow" /></span>
              <article className="reveal-card">
                <div className="reveal-preview preview-description">
                  <img src="/outlens-apple-outlined.svg" alt="Dimensional outlined apple connected to a color description" />
                  <span className="description-dot" />
                  <span className="description-line p-0" />
                  <span className="mini-label"><b>Red apple</b><small>Deep red skin with a fresh green leaf</small></span>
                </div>
                <div className="reveal-copy"><span>2</span><div><h3>Color + meaning</h3><p>Read or listen to a useful description.</p></div></div>
              </article>
              <span className="flow-arrow"><Icon name="arrow" /></span>
              <article className="reveal-card optional-card">
                <div className="optional-tag"><Icon name="spark" className="size-4" /> Optional</div>
                <div className="reveal-preview preview-enhanced">
                  <span className="compare-pane original-pane">
                    <img src="/outlens-apple.svg" alt="Original view of dimensional red apple" />
                    <b>Original</b>
                  </span>
                  <span className="compare-pane enhanced-pane">
                    <img src="/outlens-apple.svg" alt="Enhanced view of dimensional red apple" />
                    <b>Enhanced</b>
                  </span>
                </div>
                <div className="reveal-copy"><span>3</span><div><h3>Enhanced view</h3><p>Apply an approximate visual adjustment.</p></div></div>
              </article>
            </div>
          </Container>
        </section>

        <section id="help" className="section pale-section">
          <Container>
            <SectionHeading
              eyebrow="Where it helps"
              title="Everyday moments, made clearer."
              body="Designed for common questions where color carries useful context."
            />
            <div className="help-grid">
              {helpCards.map((card) => (
                <article className="help-card" key={card.title}>
                  <span className="icon-box"><Icon name={card.icon} /></span>
                  <h3>{card.title}</h3>
                  <p>{card.text}</p>
                </article>
              ))}
            </div>
          </Container>
        </section>

        <section id="account" className="section account-section">
          <Container>
            <SectionHeading
              eyebrow="Your Outlens"
              title="Log in. Save it. See."
              body="A personal account keeps useful color moments organized while Outlens adds context to what is in view."
            />
            <div className="account-grid">
              <article className="account-card account-login">
                <span className="account-number">01</span>
                <div className="account-icon"><span className="avatar-head" /><span className="avatar-body" /></div>
                <h3>Log in</h3>
                <p>Keep your preferences and viewing experience connected to you.</p>
              </article>
              <article className="account-card account-save">
                <span className="account-number">02</span>
                <div className="saved-stack"><span /><span /><span /></div>
                <h3>Save</h3>
                <p>Collect colors, objects, and descriptions that matter in daily life.</p>
              </article>
              <article className="account-card account-see">
                <span className="account-number">03</span>
                <img
                  className="smiling-person"
                  src="/smiling-glasses-person.svg"
                  alt="Friendly cartoon person wearing glasses and smiling"
                />
                <h3>See</h3>
                <p>Look naturally and receive useful color context directly in your view.</p>
              </article>
            </div>
          </Container>
        </section>

        <section className="section future-section">
          <Container className="future-grid">
            <div>
              <p className="eyebrow">Looking ahead</p>
              <h2>A real-world idea for what comes after screens.</h2>
              <p className="section-copy">
                Our demo shows how Outlens could live in lightweight glasses: quietly present, spatially aware, and
                ready to turn color into useful language.
              </p>
            </div>
            <figure className="glasses-frame realistic-glasses">
              <span className="concept-badge">Concept</span>
              <img
                src="https://images.unsplash.com/photo-1599838082676-55af0edd629f?auto=format&fit=crop&w=1200&q=85"
                alt="Realistic black framed glasses on a blue studio surface"
              />
              <OutlensMark className="photo-logo" />
              <div className="photo-hud"><span /><b>Indigo blue</b><small>Cool, deep tone</small></div>
              <figcaption>Vision concept using photography by Michael C on Unsplash</figcaption>
            </figure>
          </Container>
        </section>

        <section className="cta-section">
          <Container className="cta-inner">
            <p className="eyebrow">Ready to see the vision?</p>
            <h2>See Outlens in motion.</h2>
            <p>Open the live prototype on your phone and look around. Today it runs on a phone; tomorrow, on glasses.</p>
            <ButtonLink href="/explore" variant="dark">Try the live demo</ButtonLink>
          </Container>
        </section>
      </main>

      <footer>
        <Container className="footer-inner">
          <a className="wordmark" href="#" aria-label="Outlens home">
            <OutlensMark className="wordmark-symbol" />
            Outlens
          </a>
          <div className="footer-links">
            <a href="https://github.com/heyyamulya/Outlens">Repository</a>
            <span>Built at HackLanta</span>
            <a href="/privacy">Privacy</a>
          </div>
          <p>© 2026 Outlens</p>
        </Container>
      </footer>
    </div>
  );
}
