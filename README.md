# autoserv-ms-core

Recepción del taller. Persiste cliente, vehículo, orden, inspección, servicios y repuestos de la pantalla de cinco pasos.

Escucha NATS. El gateway expone `GET/POST /api/recepcion` y `PATCH /api/ordenes/:numero/estado`.
