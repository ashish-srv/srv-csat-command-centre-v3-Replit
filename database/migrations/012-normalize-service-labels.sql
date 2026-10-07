-- Keep historical issue and service-feedback labels aligned with the
-- standardized service configured on the project. Analysis text may contain
-- misspellings or conversational variants, but service_key is authoritative.

update public.issues as issue
set service_name = service.name
from public.project_services as service
where service.project_id = issue.project_id
  and service.service_key = issue.service_key
  and issue.service_name is distinct from service.name;

update public.service_feedback as feedback
set service_name = service.name
from public.project_services as service
where service.project_id = feedback.project_id
  and service.service_key = feedback.service_key
  and feedback.service_name is distinct from service.name;
