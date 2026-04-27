using System.Text.Json;
using AutoMapper;
using WebScrape.Data.Dto;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Data.Mapping;

public class AutoMapperProfile : Profile
{
    private static readonly JsonSerializerOptions DeserializeOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public AutoMapperProfile()
    {
        CreateMap<ApiKey, ApiKeyDto>();

        CreateMap<ScraperConfigEntity, ScraperConfigDto>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => s.ConfigJson.RootElement))
            .ForMember(d => d.OriginWorkerName, o => o.Ignore());

        CreateMap<CreateScraperConfigDto, ScraperConfigEntity>()
            .ForMember(d => d.ConfigJson, o => o.MapFrom(s => JsonDocument.Parse(s.ConfigJson.GetRawText(), default)));

        CreateMap<TaskBlock, TaskBlockTreeDto>()
            .ForMember(d => d.Loop,   o => o.MapFrom(s => s.BlockType == BlockType.Loop   ? DeserializeLoop(s.ConfigJsonb)   : null))
            .ForMember(d => d.Scrape, o => o.MapFrom(s => s.BlockType == BlockType.Scrape ? DeserializeScrape(s.ConfigJsonb) : null));

        CreateMap<TaskEntity, TaskDto>()
            .ForMember(d => d.SearchTerms, o => o.MapFrom(s => DeriveLegacySearchTerms(s)))
            .ForMember(d => d.Blocks, o => o.MapFrom(s => s.Blocks ?? new List<TaskBlock>()));

        CreateMap<WorkerConnection, WorkerDto>()
            .ForMember(d => d.Online, o => o.MapFrom(s => s.CurrentConnection != null));

        CreateMap<RunItem, RunItemDto>()
            .ForMember(d => d.Result, o => o.MapFrom(s => s.ResultJsonb != null ? s.ResultJsonb.RootElement : (JsonElement?)null));

        CreateMap<RunItem, RunListItemDto>()
            .ForMember(d => d.TaskName,   o => o.MapFrom(s => s.Task != null ? s.Task.Name : ""))
            .ForMember(d => d.WorkerName, o => o.MapFrom(s => s.Worker != null ? s.Worker.Name : ""));
    }

    // Returns null if the stored JSONB is shaped wrong for this block type (corrupt row).
    // The list query keeps working; the broken block surfaces as null in the DTO.
    // Anything other than a JsonException propagates so real bugs are not masked.
    private static LoopBlockConfigDto? DeserializeLoop(JsonDocument? doc)
    {
        if (doc is null) return null;
        try { return JsonSerializer.Deserialize<LoopBlockConfigDto>(doc.RootElement.GetRawText(), DeserializeOpts); }
        catch (JsonException) { return null; }
    }

    private static ScrapeBlockConfigDto? DeserializeScrape(JsonDocument? doc)
    {
        if (doc is null) return null;
        try { return JsonSerializer.Deserialize<ScrapeBlockConfigDto>(doc.RootElement.GetRawText(), DeserializeOpts); }
        catch (JsonException) { return null; }
    }

    private static string[] DeriveLegacySearchTerms(TaskEntity task)
    {
        var rootLoops = task.Blocks?.Where(b => b.ParentBlockId == null && b.BlockType == BlockType.Loop).ToList();
        if (rootLoops is null || rootLoops.Count != 1) return Array.Empty<string>();

        var configRoot = rootLoops[0].ConfigJsonb.RootElement;
        if (!configRoot.TryGetProperty("values", out var valuesElement) || valuesElement.ValueKind != JsonValueKind.Array)
            return Array.Empty<string>();

        var result = new List<string>(valuesElement.GetArrayLength());
        foreach (var v in valuesElement.EnumerateArray())
        {
            if (v.ValueKind == JsonValueKind.String) result.Add(v.GetString() ?? "");
        }
        return result.ToArray();
    }
}
