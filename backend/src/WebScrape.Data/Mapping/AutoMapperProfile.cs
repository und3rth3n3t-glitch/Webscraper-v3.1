using System.Text.Json;
using AutoMapper;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;

namespace WebScrape.Data.Mapping;

public class AutoMapperProfile : Profile
{
    public AutoMapperProfile()
    {
        CreateMap<ApiKey, ApiKeyDto>();

        CreateMap<ScraperConfigEntity, ScraperConfigDto>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => s.ConfigJson.RootElement));

        CreateMap<CreateScraperConfigDto, ScraperConfigEntity>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => JsonDocument.Parse(s.ConfigJson.GetRawText(), default)));

        CreateMap<TaskEntity, TaskDto>()
            .ForMember(d => d.ScraperConfigName, o => o.MapFrom(s => s.ScraperConfig != null ? s.ScraperConfig.Name : ""));

        CreateMap<WorkerConnection, WorkerDto>()
            .ForMember(d => d.Online, o => o.MapFrom(s => s.CurrentConnection != null));

        CreateMap<RunItem, RunItemDto>()
            .ForMember(d => d.Result, o => o.MapFrom(s => s.ResultJsonb != null ? s.ResultJsonb.RootElement : (JsonElement?)null));
    }
}
