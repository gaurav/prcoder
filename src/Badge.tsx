// A component whose markup only the tsx grammar colours as tags: prism-tsx is
// built on jsx and typescript, and prcoder has to load both first.
type Props = { label: string; count: number };

export const Badge = ({ label, count }: Props) => (
  <span className="badge" title={`${count} ${label}`}>
    {label} <strong>{count}</strong>
  </span>
);
