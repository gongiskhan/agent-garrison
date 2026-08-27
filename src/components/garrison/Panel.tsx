import clsx from "clsx";
import styles from "./GarrisonHome.module.css";

// The dashboard's panel frame. Lifted out of GarrisonHome so panels that live
// in their own module (MeshPanel's compact variant) sit in the same grid
// without a second, subtly-different frame. The styles stay in
// GarrisonHome.module.css — the panel IS the dashboard's chrome, and splitting
// the stylesheet would put .panel and .panelFeature's grid-row span in
// different files.
export function Panel({
  title,
  children,
  tight,
  feature
}: {
  title: string;
  children: React.ReactNode;
  tight?: boolean;
  feature?: boolean;
}) {
  return (
    <section
      className={clsx(
        styles.panel,
        tight && styles.panelTight,
        feature && styles.panelFeature
      )}
    >
      <h4 className={styles.panelTitle}>
        {title}
      </h4>
      {children}
    </section>
  );
}
