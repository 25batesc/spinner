import type { SessionView } from "@spinner/protocol";

export function ServiceTable({ view }: { view: SessionView }) {
    const { services } = view.stack;
    if (services.length === 0) {
        return <p className="muted">No services: this session has no stack.</p>;
    }
    return (
        <table className="services" aria-label="Services">
            <thead>
                <tr>
                    <th>service</th>
                    <th>where</th>
                    <th>status</th>
                    <th>url</th>
                </tr>
            </thead>
            <tbody>
                {services.map((service) => (
                    <tr key={service.name}>
                        <td>{service.name}</td>
                        <td>{service.where}</td>
                        <td>
                            <span className={`dot dot-${service.status}`} /> {service.status}
                        </td>
                        <td>{service.url ?? <span className="muted">internal</span>}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
