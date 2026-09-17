import type {CSSProperties} from 'react';
import styles from './NodeChip.module.css';

type ChipNode = {name: string; accentColor: string};
export function NodeChip({node, showName = true}: {node: ChipNode; showName?: boolean}) {
  const letters = node.name.split(/[\s._-]+/).filter(Boolean).map(word => word[0]).join('').slice(0, 2).toUpperCase();
  return <span className={styles.chip} style={{'--node-accent': node.accentColor} as CSSProperties}>
    <span className={styles.monogram} aria-hidden="true">{letters}</span>{showName && <span>{node.name}</span>}
  </span>;
}
