export default function Marquee() {
  const facts = [
    "Never submits on your behalf",
    "No patient data stored",
    "Identifiers never sent to the model",
    "Leaves a field blank rather than guess",
  ];
  return (
    <div className="marquee">
      {facts.map((f) => (
        <span key={f}>{f}</span>
      ))}
    </div>
  );
}
