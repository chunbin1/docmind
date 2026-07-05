import styles from './DocumentTag.module.css'

interface DocumentTagProps {
  filename: string
  selected: boolean
  onToggle: () => void
}

export function DocumentTag({ filename, selected, onToggle }: DocumentTagProps) {
  const short = filename.length > 20 ? filename.slice(0, 18) + '…' : filename
  return (
    <button
      type="button"
      className={`${styles.tag} ${selected ? styles.selected : ''}`}
      onClick={onToggle}
      aria-pressed={selected}
      title={filename}
    >
      <span className={styles.icon}>📄</span>
      <span className={styles.name}>{short}</span>
    </button>
  )
}
