import styles from './DocumentChip.module.css'

interface DocumentChipProps {
  filename: string
  onRemove: () => void
}

export function DocumentChip({ filename, onRemove }: DocumentChipProps) {
  const short = filename.length > 20 ? filename.slice(0, 18) + '…' : filename
  return (
    <span className={styles.chip}>
      <span className={styles.icon}>📄</span>
      <span className={styles.name} title={filename}>{short}</span>
      <button className={styles.remove} onClick={onRemove} aria-label={`移除 ${filename}`}>×</button>
    </span>
  )
}
