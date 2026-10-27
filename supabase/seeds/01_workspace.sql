insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,email_change,email_change_token_new,recovery_token)
values
  ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000000001','authenticated','authenticated','owner@demo.local',extensions.crypt('demo-password',extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"],"principal_type":"human"}','{"full_name":"Demo Owner"}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000000002','authenticated','authenticated','editor@demo.local',extensions.crypt('demo-password',extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"],"principal_type":"human"}','{"full_name":"Demo Editor"}',now(),now(),'','','','')
on conflict(id) do nothing;
insert into auth.identities(id,user_id,provider_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
select id,id,id::text,jsonb_build_object('sub',id::text,'email',email,'email_verified',true,'phone_verified',false),'email',now(),now(),now()
from auth.users where id in ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')
on conflict(provider_id,provider) do nothing;
insert into public.workspaces(id,name,owner_id,root_order,revision)
values('00000000-0000-4000-8000-000000000010','Demo','00000000-0000-4000-8000-000000000001','["market-research","notes","wiki","private"]',1)
on conflict(id) do nothing;
insert into public.workspace_members(workspace_id,user_id,role)
values
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','owner'),
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000002','editor')
on conflict(workspace_id,user_id) do nothing;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',false);

insert into public.pages(id,workspace_id,parent_id,data,published,revision) values('market-research','00000000-0000-4000-8000-000000000010',null,$page${
  "id": "market-research",
  "title": "Market research",
  "icon": "🤖",
  "cover": null,
  "parentId": null,
  "blocks": [],
  "isFavorite": false,
  "isDeleted": false,
  "fullWidth": false,
  "smallText": false,
  "createdAt": 1793059200000,
  "updatedAt": 1793059200000,
  "revision": 1,
  "database": {
    "properties": [
      {
        "id": "title",
        "name": "Task",
        "type": "text"
      },
      {
        "id": "lead",
        "name": "Lead",
        "type": "person"
      },
      {
        "id": "worker",
        "name": "Worker",
        "type": "agentDelegate"
      },
      {
        "id": "status",
        "name": "Status",
        "type": "agentStatus"
      },
      {
        "id": "waiting-on",
        "name": "Waiting on",
        "type": "select",
        "options": [
          {
            "id": "waiting-on-0",
            "name": "You",
            "color": "yellow"
          },
          {
            "id": "waiting-on-1",
            "name": "Lead",
            "color": "blue"
          },
          {
            "id": "waiting-on-2",
            "name": "Worker",
            "color": "purple"
          },
          {
            "id": "waiting-on-3",
            "name": "Nobody",
            "color": "gray"
          }
        ]
      },
      {
        "id": "done-when",
        "name": "Done when",
        "type": "text"
      },
      {
        "id": "depends-on",
        "name": "Depends on",
        "type": "relation",
        "relationDbId": "market-research"
      },
      {
        "id": "output",
        "name": "Output",
        "type": "url"
      },
      {
        "id": "cost",
        "name": "Cost",
        "type": "number",
        "numberFormat": "dollar"
      },
      {
        "id": "run",
        "name": "Run",
        "type": "id",
        "idPrefix": "RUN",
        "nextId": 4
      }
    ],
    "views": [
      {
        "id": "view-0",
        "name": "Table",
        "type": "table",
        "sorts": [],
        "filters": []
      },
      {
        "id": "view-1",
        "name": "Waiting on you",
        "type": "table",
        "sorts": [],
        "filters": [
          {
            "id": "GeM8Xz3JXsFo",
            "propertyId": "status",
            "operator": "is",
            "value": "input_required"
          },
          {
            "id": "Cna7U2Uo5aO7",
            "propertyId": "status",
            "operator": "is",
            "value": "ready_for_review"
          }
        ],
        "filterConjunction": "or"
      },
      {
        "id": "view-2",
        "name": "Working",
        "type": "table",
        "sorts": [],
        "filters": [
          {
            "id": "qdfexj_3y6aX",
            "propertyId": "status",
            "operator": "is",
            "value": "working"
          }
        ]
      },
      {
        "id": "view-3",
        "name": "Board",
        "type": "board",
        "groupBy": "status",
        "sorts": [],
        "filters": []
      }
    ],
    "rows": [
      {
        "id": "research-row-1",
        "pageId": "research-task-1",
        "cells": {
          "title": "Map customer needs",
          "run": 1
        },
        "rev": 1,
        "createdAt": 1793059200000,
        "updatedAt": 1793059200000,
        "createdBy": "00000000-0000-4000-8000-000000000001",
        "lastEditedBy": "00000000-0000-4000-8000-000000000001"
      },
      {
        "id": "research-row-2",
        "pageId": "research-task-2",
        "cells": {
          "title": "Compare alternatives",
          "run": 2
        },
        "rev": 1,
        "createdAt": 1793059200000,
        "updatedAt": 1793059200000,
        "createdBy": "00000000-0000-4000-8000-000000000001",
        "lastEditedBy": "00000000-0000-4000-8000-000000000001"
      },
      {
        "id": "research-row-3",
        "pageId": "research-task-3",
        "cells": {
          "title": "Summarize findings",
          "run": 3
        },
        "rev": 1,
        "createdAt": 1793059200000,
        "updatedAt": 1793059200000,
        "createdBy": "00000000-0000-4000-8000-000000000001",
        "lastEditedBy": "00000000-0000-4000-8000-000000000001"
      }
    ],
    "rowTemplates": [
      {
        "id": "brief-template-0",
        "name": "Task brief",
        "icon": null,
        "cells": {},
        "blocks": [
          {
            "id": "brief-0",
            "type": "heading2",
            "html": "Goal",
            "indent": 0,
            "key": "brief:goal",
            "rev": 1
          },
          {
            "id": "brief-1",
            "type": "paragraph",
            "html": "",
            "indent": 0,
            "rev": 1
          },
          {
            "id": "brief-2",
            "type": "heading2",
            "html": "Done when",
            "indent": 0,
            "key": "brief:done_when",
            "rev": 1
          },
          {
            "id": "brief-3",
            "type": "todo",
            "html": "",
            "indent": 0,
            "rev": 1
          },
          {
            "id": "brief-4",
            "type": "heading2",
            "html": "Constraints",
            "indent": 0,
            "key": "brief:constraints",
            "rev": 1
          },
          {
            "id": "brief-5",
            "type": "paragraph",
            "html": "",
            "indent": 0,
            "rev": 1
          },
          {
            "id": "brief-6",
            "type": "heading2",
            "html": "Sources",
            "indent": 0,
            "key": "brief:sources",
            "rev": 1
          },
          {
            "id": "brief-7",
            "type": "paragraph",
            "html": "",
            "indent": 0,
            "rev": 1
          }
        ]
      }
    ],
    "id": "agent-tasks"
  }
}$page$::jsonb,false,1) on conflict(id) do nothing;
insert into public.pages(id,workspace_id,parent_id,data,published,revision) values('notes','00000000-0000-4000-8000-000000000010',null,$page${
  "id": "notes",
  "title": "Notes",
  "icon": null,
  "cover": null,
  "parentId": null,
  "blocks": [
    {
      "id": "notes-text",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    }
  ],
  "isFavorite": false,
  "isDeleted": false,
  "fullWidth": false,
  "smallText": false,
  "createdAt": 1793059200000,
  "updatedAt": 1793059200000,
  "revision": 1
}$page$::jsonb,false,1) on conflict(id) do nothing;
insert into public.pages(id,workspace_id,parent_id,data,published,revision) values('wiki','00000000-0000-4000-8000-000000000010',null,$page${
  "id": "wiki",
  "title": "Wiki",
  "icon": null,
  "cover": null,
  "parentId": null,
  "blocks": [
    {
      "id": "wiki-text",
      "type": "paragraph",
      "html": "Welcome to the shared workspace.",
      "indent": 0,
      "rev": 1
    }
  ],
  "isFavorite": false,
  "isDeleted": false,
  "fullWidth": false,
  "smallText": false,
  "createdAt": 1793059200000,
  "updatedAt": 1793059200000,
  "revision": 1
}$page$::jsonb,true,1) on conflict(id) do nothing;
insert into public.pages(id,workspace_id,parent_id,data,published,revision) values('private','00000000-0000-4000-8000-000000000010',null,$page${
  "id": "private",
  "title": "Private",
  "icon": null,
  "cover": null,
  "parentId": null,
  "blocks": [
    {
      "id": "private-text",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    }
  ],
  "isFavorite": false,
  "isDeleted": false,
  "fullWidth": false,
  "smallText": false,
  "createdAt": 1793059200000,
  "updatedAt": 1793059200000,
  "revision": 1
}$page$::jsonb,false,1) on conflict(id) do nothing;
insert into public.pages(id,workspace_id,parent_id,data,published,revision) values('research-task-1','00000000-0000-4000-8000-000000000010','market-research',$page${
  "id": "research-task-1",
  "title": "Map customer needs",
  "icon": null,
  "cover": null,
  "parentId": "market-research",
  "blocks": [
    {
      "id": "research-task-1-0",
      "type": "heading2",
      "html": "Goal",
      "indent": 0,
      "key": "brief:goal",
      "rev": 1
    },
    {
      "id": "research-task-1-1",
      "type": "paragraph",
      "html": "Map customer needs",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-1-2",
      "type": "heading2",
      "html": "Done when",
      "indent": 0,
      "key": "brief:done_when",
      "rev": 1
    },
    {
      "id": "research-task-1-3",
      "type": "todo",
      "html": "",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-1-4",
      "type": "heading2",
      "html": "Constraints",
      "indent": 0,
      "key": "brief:constraints",
      "rev": 1
    },
    {
      "id": "research-task-1-5",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-1-6",
      "type": "heading2",
      "html": "Sources",
      "indent": 0,
      "key": "brief:sources",
      "rev": 1
    },
    {
      "id": "research-task-1-7",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    }
  ],
  "isFavorite": false,
  "isDeleted": false,
  "fullWidth": false,
  "smallText": false,
  "createdAt": 1793059200000,
  "updatedAt": 1793059200000,
  "revision": 1
}$page$::jsonb,false,1) on conflict(id) do nothing;
insert into public.pages(id,workspace_id,parent_id,data,published,revision) values('research-task-2','00000000-0000-4000-8000-000000000010','market-research',$page${
  "id": "research-task-2",
  "title": "Compare alternatives",
  "icon": null,
  "cover": null,
  "parentId": "market-research",
  "blocks": [
    {
      "id": "research-task-2-0",
      "type": "heading2",
      "html": "Goal",
      "indent": 0,
      "key": "brief:goal",
      "rev": 1
    },
    {
      "id": "research-task-2-1",
      "type": "paragraph",
      "html": "Compare alternatives",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-2-2",
      "type": "heading2",
      "html": "Done when",
      "indent": 0,
      "key": "brief:done_when",
      "rev": 1
    },
    {
      "id": "research-task-2-3",
      "type": "todo",
      "html": "",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-2-4",
      "type": "heading2",
      "html": "Constraints",
      "indent": 0,
      "key": "brief:constraints",
      "rev": 1
    },
    {
      "id": "research-task-2-5",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-2-6",
      "type": "heading2",
      "html": "Sources",
      "indent": 0,
      "key": "brief:sources",
      "rev": 1
    },
    {
      "id": "research-task-2-7",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    }
  ],
  "isFavorite": false,
  "isDeleted": false,
  "fullWidth": false,
  "smallText": false,
  "createdAt": 1793059200000,
  "updatedAt": 1793059200000,
  "revision": 1
}$page$::jsonb,false,1) on conflict(id) do nothing;
insert into public.pages(id,workspace_id,parent_id,data,published,revision) values('research-task-3','00000000-0000-4000-8000-000000000010','market-research',$page${
  "id": "research-task-3",
  "title": "Summarize findings",
  "icon": null,
  "cover": null,
  "parentId": "market-research",
  "blocks": [
    {
      "id": "research-task-3-0",
      "type": "heading2",
      "html": "Goal",
      "indent": 0,
      "key": "brief:goal",
      "rev": 1
    },
    {
      "id": "research-task-3-1",
      "type": "paragraph",
      "html": "Summarize findings",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-3-2",
      "type": "heading2",
      "html": "Done when",
      "indent": 0,
      "key": "brief:done_when",
      "rev": 1
    },
    {
      "id": "research-task-3-3",
      "type": "todo",
      "html": "",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-3-4",
      "type": "heading2",
      "html": "Constraints",
      "indent": 0,
      "key": "brief:constraints",
      "rev": 1
    },
    {
      "id": "research-task-3-5",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    },
    {
      "id": "research-task-3-6",
      "type": "heading2",
      "html": "Sources",
      "indent": 0,
      "key": "brief:sources",
      "rev": 1
    },
    {
      "id": "research-task-3-7",
      "type": "paragraph",
      "html": "",
      "indent": 0,
      "rev": 1
    }
  ],
  "isFavorite": false,
  "isDeleted": false,
  "fullWidth": false,
  "smallText": false,
  "createdAt": 1793059200000,
  "updatedAt": 1793059200000,
  "revision": 1
}$page$::jsonb,false,1) on conflict(id) do nothing;
select set_config('request.jwt.claims','{}',false);
